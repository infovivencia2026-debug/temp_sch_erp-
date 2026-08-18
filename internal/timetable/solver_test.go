package timetable

import (
	"fmt"
	"strings"
	"testing"
)

// A five-day, six-period week — the grid most Indian day schools run once
// breaks are taken out.
func week(days, periods int) Grid {
	g := Grid{}
	for d := 1; d <= days; d++ {
		g.Weekdays = append(g.Weekdays, d)
	}
	for p := 1; p <= periods; p++ {
		g.Periods = append(g.Periods, Period{
			ID: fmt.Sprintf("p%d", p), Name: fmt.Sprintf("Period %d", p), Sequence: p,
		})
	}
	return g
}

func req(section, subject, teacher string, ppw int) Requirement {
	return Requirement{
		SectionID:      "sec-" + section,
		SectionName:    section,
		ClassSubjectID: "cs-" + section + "-" + subject,
		SubjectName:    subject,
		TeacherID:      teacher,
		PeriodsPerWeek: ppw,
	}
}

func teacher(id, name string, perDay, perWeek int) Teacher {
	return Teacher{UserID: id, Name: name, MaxPerDay: perDay, MaxPerWeek: perWeek}
}

// --- the hard constraints ----------------------------------------------------

/*
The two clashes a timetable exists to prevent.

	A teacher in two rooms at once and a section with two subjects at once are
	not scheduling inefficiencies; they are the timetable being wrong. Either
	one on a published grid means a class sits unattended on a Tuesday, so
	these are asserted over the whole output rather than sampled.
*/
func TestNoTeacherOrSectionIsEverDoubleBooked(t *testing.T) {
	in := Input{
		Grid: week(6, 7),
		Requirements: []Requirement{
			req("6A", "Maths", "t1", 6), req("6A", "English", "t2", 5),
			req("6A", "Science", "t3", 5), req("6A", "Hindi", "t4", 4),
			req("6B", "Maths", "t1", 6), req("6B", "English", "t2", 5),
			req("6B", "Science", "t3", 5), req("6B", "Hindi", "t4", 4),
			req("7A", "Maths", "t1", 6), req("7A", "English", "t2", 5),
			req("7A", "Science", "t3", 5), req("7A", "Hindi", "t4", 4),
		},
		Teachers: []Teacher{
			teacher("t1", "R Iyer", 6, 30), teacher("t2", "S Nair", 6, 30),
			teacher("t3", "A Khan", 6, 30), teacher("t4", "P Das", 6, 30),
		},
		Seed: 7,
	}
	res := Generate(in)

	seenTeacher := map[string]Placement{}
	seenSection := map[string]Placement{}
	for _, p := range res.Placements {
		tk := fmt.Sprintf("%s|%d|%s", p.TeacherID, p.Weekday, p.PeriodID)
		if prev, dup := seenTeacher[tk]; dup && p.TeacherID != "" {
			t.Fatalf("teacher %s double-booked on weekday %d %s: %s and %s",
				p.TeacherID, p.Weekday, p.PeriodID, prev.SectionName, p.SectionName)
		}
		seenTeacher[tk] = p

		sk := fmt.Sprintf("%s|%d|%s", p.SectionID, p.Weekday, p.PeriodID)
		if prev, dup := seenSection[sk]; dup {
			t.Fatalf("section %s double-booked on weekday %d %s: %s and %s",
				p.SectionName, p.Weekday, p.PeriodID, prev.SubjectName, p.SubjectName)
		}
		seenSection[sk] = p
	}
}

// A slot the teacher declared unavailable is never used, and the periods that
// would have gone there are reported rather than quietly dropped elsewhere.
func TestUnavailableSlotsAreNeverUsed(t *testing.T) {
	blocked := []Slot{}
	for p := 1; p <= 6; p++ {
		blocked = append(blocked, Slot{Weekday: 3, PeriodID: fmt.Sprintf("p%d", p)})
	}
	in := Input{
		Grid:         week(5, 6),
		Requirements: []Requirement{req("8B", "Maths", "t1", 5)},
		Teachers: []Teacher{{
			UserID: "t1", Name: "V Menon", MaxPerDay: 6, MaxPerWeek: 30,
			Unavailable: blocked,
		}},
		Seed: 3,
	}
	res := Generate(in)
	for _, p := range res.Placements {
		if p.Weekday == 3 {
			t.Fatalf("placed a period on the teacher's unavailable day: %+v", p)
		}
	}
	if res.Placed != 5 {
		t.Fatalf("five periods should still fit in the remaining four days, placed %d", res.Placed)
	}
}

// The weekly cap is a hard limit. Exceeding it is how a generator produces a
// timetable that looks complete and is unworkable on the first Monday.
func TestWeeklyCapIsNeverExceeded(t *testing.T) {
	in := Input{
		Grid: week(6, 6),
		Requirements: []Requirement{
			req("9A", "Maths", "t1", 8), req("9B", "Maths", "t1", 8), req("9C", "Maths", "t1", 8),
		},
		Teachers: []Teacher{teacher("t1", "K Rao", 5, 20)},
		Seed:     11,
	}
	res := Generate(in)
	n := 0
	for _, p := range res.Placements {
		if p.TeacherID == "t1" {
			n++
		}
	}
	if n > 20 {
		t.Fatalf("teacher placed into %d periods against a cap of 20", n)
	}
	perDay := map[int]int{}
	for _, p := range res.Placements {
		perDay[p.Weekday]++
	}
	for d, c := range perDay {
		if c > 5 {
			t.Fatalf("weekday %d holds %d periods against a daily cap of 5", d, c)
		}
	}
}

// Periods already committed elsewhere in the school consume the cap. Without
// this the draft looks feasible and collides with the sections outside it.
func TestCommittedPeriodsBlockTheirSlots(t *testing.T) {
	committed := []Slot{
		{Weekday: 1, PeriodID: "p1"}, {Weekday: 1, PeriodID: "p2"},
		{Weekday: 2, PeriodID: "p1"}, {Weekday: 2, PeriodID: "p2"},
	}
	in := Input{
		Grid:         week(2, 3),
		Requirements: []Requirement{req("10A", "Physics", "t1", 4)},
		Teachers: []Teacher{{
			UserID: "t1", Name: "N Bose", MaxPerDay: 3, MaxPerWeek: 10,
			Committed: committed,
		}},
		Seed: 5,
	}
	res := Generate(in)
	for _, p := range res.Placements {
		for _, c := range committed {
			if p.Weekday == c.Weekday && p.PeriodID == c.PeriodID {
				t.Fatalf("placed into a slot the teacher is already committed to: %+v", p)
			}
		}
	}
	// Two free slots, four periods wanted: exactly two must be reported unmet.
	if res.Placed != 2 {
		t.Fatalf("expected 2 placed, got %d", res.Placed)
	}
	if !res.Blocking() {
		t.Fatal("two periods went unplaced and nothing was reported")
	}
}

// --- the failure report ------------------------------------------------------

/*
The report is the product, and this is the sentence it exists to produce.

	A generator that drops two of Class 8B's six Maths periods and says nothing
	is worse than one that refuses outright, because the gap is discovered in
	week three by the class. The requirement is not merely that an issue is
	raised: it must name the binding constraint and the number the reader needs
	to act on — the teacher's load against their cap.
*/
func TestUnmetRequirementNamesTheTeacherAtTheirCap(t *testing.T) {
	in := Input{
		Grid: week(6, 6),
		Requirements: []Requirement{
			req("8A", "Maths", "t1", 6),
			req("8B", "Maths", "t1", 6),
			req("8C", "Maths", "t1", 6),
			req("8D", "Maths", "t1", 6),
			req("8E", "Maths", "t1", 6),
			req("8F", "Maths", "t1", 6),
		},
		Teachers: []Teacher{teacher("t1", "Ramesh Kumar", 6, 35)},
		Seed:     2,
	}
	res := Generate(in)

	if res.Placed != 35 {
		t.Fatalf("the cap is 35 periods; %d were placed", res.Placed)
	}
	if res.Required-res.Placed != 1 {
		t.Fatalf("36 wanted against a cap of 35: exactly 1 should be short, got %d",
			res.Required-res.Placed)
	}

	var unmet *Issue
	for i := range res.Issues {
		if res.Issues[i].Kind == IssueUnmet {
			unmet = &res.Issues[i]
		}
	}
	if unmet == nil {
		t.Fatal("a period went unplaced and no unmet_periods issue was raised")
	}
	if unmet.Severity != SeverityBlocking {
		t.Errorf("an unmet requirement must be blocking, got %q", unmet.Severity)
	}
	for _, want := range []string{"Ramesh Kumar", "35"} {
		if !strings.Contains(unmet.Detail, want) {
			t.Errorf("detail should name %q so the reader can act on it; got: %s", want, unmet.Detail)
		}
	}

	// And the whole-teacher problem is stated once up front, not inferred from
	// six per-subject failures.
	found := false
	for _, i := range res.Issues {
		if i.Kind == IssueTeacherOversubscribed && i.TeacherName == "Ramesh Kumar" {
			found = true
			if i.Required != 36 || i.Placed != 35 {
				t.Errorf("oversubscription should read 36 against 35, got %d against %d",
					i.Required, i.Placed)
			}
		}
	}
	if !found {
		t.Error("a teacher owing more periods than their cap should be reported before placement")
	}
}

// A section wanting more periods than the week has slots is a fact about the
// input; it must be stated plainly rather than emerging as a dozen failures.
func TestSectionOversubscriptionIsReportedUpFront(t *testing.T) {
	in := Input{
		Grid: week(5, 4), // 20 slots
		Requirements: []Requirement{
			req("11A", "Physics", "t1", 8), req("11A", "Chemistry", "t2", 8),
			req("11A", "Maths", "t3", 8),
		},
		Teachers: []Teacher{teacher("t1", "A", 6, 40), teacher("t2", "B", 6, 40), teacher("t3", "C", 6, 40)},
		Seed:     1,
	}
	res := Generate(in)
	var over *Issue
	for i := range res.Issues {
		if res.Issues[i].Kind == IssueSectionOversubscribed {
			over = &res.Issues[i]
		}
	}
	if over == nil {
		t.Fatal("24 periods into a 20-slot week should be reported as oversubscribed")
	}
	if over.Required != 24 || over.Placed != 20 {
		t.Errorf("expected 24 against 20, got %d against %d", over.Required, over.Placed)
	}
	if res.Placed > 20 {
		t.Fatalf("placed %d periods into a 20-slot week", res.Placed)
	}
}

// A subject with no teacher is still worth timetabling, and the hole is worth
// naming. A school allocates the periods before it hires.
func TestUnstaffedSubjectIsPlacedAndFlagged(t *testing.T) {
	in := Input{
		Grid:         week(5, 5),
		Requirements: []Requirement{req("7C", "Sanskrit", "", 4)},
		Seed:         9,
	}
	res := Generate(in)
	if res.Placed != 4 {
		t.Fatalf("an unstaffed subject should still occupy its periods, placed %d", res.Placed)
	}
	found := false
	for _, i := range res.Issues {
		if i.Kind == IssueNoTeacher {
			found = true
			if i.Severity != SeverityWarning {
				t.Errorf("no teacher yet is a warning, not a refusal; got %q", i.Severity)
			}
		}
	}
	if !found {
		t.Error("four periods with nobody to teach them and no issue raised")
	}
}

// --- soft preferences --------------------------------------------------------

/*
Spread beats stacking.

	Six periods of Maths over six days is one a day. A generator that fills
	Monday with three of them has technically satisfied the requirement and
	produced a week no school would run, so this is asserted rather than
	trusted to the scoring weights.
*/
func TestASubjectIsSpreadAcrossTheWeekNotStacked(t *testing.T) {
	in := Input{
		Grid: week(6, 6),
		Requirements: []Requirement{
			req("9A", "Maths", "t1", 6), req("9A", "English", "t2", 6),
			req("9A", "Science", "t3", 6), req("9A", "Hindi", "t4", 6),
		},
		Teachers: []Teacher{
			teacher("t1", "A", 6, 36), teacher("t2", "B", 6, 36),
			teacher("t3", "C", 6, 36), teacher("t4", "D", 6, 36),
		},
		Seed: 4,
	}
	res := Generate(in)
	perDay := map[string]map[int]int{}
	for _, p := range res.Placements {
		if perDay[p.SubjectName] == nil {
			perDay[p.SubjectName] = map[int]int{}
		}
		perDay[p.SubjectName][p.Weekday]++
	}
	for subj, days := range perDay {
		for d, n := range days {
			if n > 1 {
				t.Errorf("%s appears %d times on weekday %d; six periods over six days is one a day",
					subj, n, d)
			}
		}
	}
}

/*
A subject marked difficult takes the earlier period when the two compete.

	The grid here is one day of four periods holding two periods each of Maths
	and Art, so every placement is a direct contest for position — which is the
	only arrangement that tests the preference at all. Given a week with room
	to spare both subjects sit first period on different days and the
	preference never comes up.
*/
func TestDifficultSubjectsTakeTheEarlierPeriod(t *testing.T) {
	hard := req("10A", "Maths", "t1", 2)
	hard.Difficult = true
	soft := req("10A", "Art", "t2", 2)

	in := Input{
		Grid:         week(1, 4),
		Requirements: []Requirement{hard, soft},
		Teachers:     []Teacher{teacher("t1", "A", 4, 4), teacher("t2", "B", 4, 4)},
		Seed:         6,
	}
	res := Generate(in)
	if res.Placed != 4 {
		t.Fatalf("four periods into four slots, placed %d", res.Placed)
	}

	sum := map[string]int{}
	n := map[string]int{}
	for _, p := range res.Placements {
		var seq int
		fmt.Sscanf(p.PeriodID, "p%d", &seq)
		sum[p.SubjectName] += seq
		n[p.SubjectName]++
	}
	if n["Maths"] == 0 || n["Art"] == 0 {
		t.Fatal("both subjects should have been placed")
	}
	avgHard := float64(sum["Maths"]) / float64(n["Maths"])
	avgSoft := float64(sum["Art"]) / float64(n["Art"])
	if avgHard >= avgSoft {
		t.Errorf("a difficult subject should sit earlier on average: Maths %.2f, Art %.2f",
			avgHard, avgSoft)
	}
}

// --- determinism -------------------------------------------------------------

/*
The same input and seed must give the same timetable, byte for byte.

	Without it no test above can assert a cell, a school cannot reproduce the
	draft it reviewed yesterday, and "generate again" silently becomes "roll
	the dice". The generator therefore takes its seed as a parameter and never
	touches the clock or the rand global.
*/
func TestGenerationIsDeterministicForAFixedSeed(t *testing.T) {
	build := func() Input {
		return Input{
			Grid: week(6, 7),
			Requirements: []Requirement{
				req("6A", "Maths", "t1", 6), req("6A", "English", "t2", 5),
				req("6B", "Maths", "t1", 6), req("6B", "Science", "t3", 5),
				req("7A", "Hindi", "t4", 4), req("7A", "Maths", "t1", 5),
			},
			Teachers: []Teacher{
				teacher("t1", "A", 6, 30), teacher("t2", "B", 6, 30),
				teacher("t3", "C", 6, 30), teacher("t4", "D", 6, 30),
			},
			Seed: 42,
		}
	}
	a, b := Generate(build()), Generate(build())
	if len(a.Placements) != len(b.Placements) {
		t.Fatalf("same seed gave %d and %d placements", len(a.Placements), len(b.Placements))
	}
	for i := range a.Placements {
		if a.Placements[i] != b.Placements[i] {
			t.Fatalf("placement %d differs between runs: %+v vs %+v", i, a.Placements[i], b.Placements[i])
		}
	}
	if len(a.Issues) != len(b.Issues) {
		t.Fatalf("same seed gave %d and %d issues", len(a.Issues), len(b.Issues))
	}
	for i := range a.Issues {
		if a.Issues[i] != b.Issues[i] {
			t.Fatalf("issue %d differs between runs:\n %+v\n %+v", i, a.Issues[i], b.Issues[i])
		}
	}
}

// A different seed is allowed to produce a different candidate — that is what
// "generate another option" means — but it must still be a legal one.
func TestADifferentSeedGivesADifferentButValidCandidate(t *testing.T) {
	build := func(seed int64) Input {
		return Input{
			Grid: week(6, 7),
			Requirements: []Requirement{
				req("6A", "Maths", "t1", 6), req("6A", "English", "t2", 5),
				req("6B", "Maths", "t1", 6), req("6B", "Science", "t3", 5),
			},
			Teachers: []Teacher{
				teacher("t1", "A", 6, 30), teacher("t2", "B", 6, 30), teacher("t3", "C", 6, 30),
			},
			Seed: seed,
		}
	}
	a, b := Generate(build(1)), Generate(build(999))
	if a.Placed != b.Placed {
		t.Errorf("both seeds satisfy the same requirements: %d vs %d placed", a.Placed, b.Placed)
	}
	same := len(a.Placements) == len(b.Placements)
	if same {
		for i := range a.Placements {
			if a.Placements[i] != b.Placements[i] {
				same = false
				break
			}
		}
	}
	if same {
		t.Error("two very different seeds produced an identical grid; the tie-break is not seeded")
	}
}

// --- the everyday case -------------------------------------------------------

// A middle-school week that ought to solve completely. If this leaves anything
// unmet the weights are wrong, not the school.
func TestAnOrdinaryWeekSolvesCompletely(t *testing.T) {
	in := Input{Grid: week(6, 7), Seed: 17}
	subjects := []struct {
		name string
		ppw  int
	}{
		{"Maths", 6}, {"English", 6}, {"Science", 6}, {"Social", 5},
		{"Hindi", 5}, {"Computer", 3}, {"PE", 2},
	}
	for si, sec := range []string{"6A", "6B", "7A"} {
		for ti, sub := range subjects {
			// One teacher per subject per two sections, which is how a small
			// school actually staffs it.
			tid := fmt.Sprintf("t%d", ti*2+si/2)
			in.Requirements = append(in.Requirements, req(sec, sub.name, tid, sub.ppw))
		}
	}
	seen := map[string]bool{}
	for _, r := range in.Requirements {
		if !seen[r.TeacherID] {
			seen[r.TeacherID] = true
			in.Teachers = append(in.Teachers, teacher(r.TeacherID, "T "+r.TeacherID, 6, 36))
		}
	}
	res := Generate(in)
	if res.Blocking() {
		for _, i := range res.Issues {
			if i.Severity == SeverityBlocking {
				t.Errorf("unmet in an ordinary week: %s", i.Detail)
			}
		}
	}
	if res.Placed != res.Required {
		t.Fatalf("placed %d of %d periods", res.Placed, res.Required)
	}
}
