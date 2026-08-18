/*
Package timetable generates a candidate weekly timetable.

	What this is, said plainly: a constraint-satisfying generator, not a
	solver. Timetabling is NP-hard and nothing here beats the vice principal
	who has done it for fifteen years. What it does do is produce a *draft* in
	a few milliseconds that obeys every hard constraint, and — the part that
	actually matters — hand back a written list of the requirements it could
	not meet and why. A generator that silently drops two of Class 8B's six
	Maths periods is worse than one that refuses, because the school finds out
	in week three.

	Three properties the caller depends on:

	  - Pure. Nothing here reads a database, a clock or the rand global. Seed
	    is a parameter, so the same Input produces the same Result on every
	    machine and a test can assert the grid cell by cell.
	  - Never writes over a live timetable. Generate returns placements; the
	    API layer stores them as a draft a human publishes explicitly.
	  - The failure report is a first-class output, not an error. Result.Issues
	    carries one entry per unmet requirement with the binding constraint
	    named in a sentence a head of department can act on.

	Hard constraints (never violated, the requirement goes unmet instead):

	  - a section cannot hold two subjects in one slot
	  - a teacher cannot be in two rooms at once, counting periods already
	    committed elsewhere in the school
	  - a teacher's declared unavailable slots
	  - a teacher's maximum periods per day and per week

	Soft preferences (scored, and reported when they had to bend):

	  - spread a subject across the week rather than stacking it on Tuesday
	  - put difficult subjects earlier in the day
	  - do not strand a single free period in the middle of a teacher's day
	  - keep a teacher's daily load even across the week
*/
package timetable

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
)

// Slot is one cell of the weekly grid: an ISO weekday (1 = Monday) and a
// period. The period is an opaque id, so the caller's period table is the only
// place the clock times live.
type Slot struct {
	Weekday  int    `json:"weekday"`
	PeriodID string `json:"period_id"`
}

// Period is one teaching period of the day. Breaks are the caller's business:
// pass only the periods a lesson may occupy.
type Period struct {
	ID       string
	Name     string
	Sequence int
}

// Grid is the week the school actually teaches — Monday to Saturday in most of
// India, and whichever periods are not breaks.
type Grid struct {
	Weekdays []int
	Periods  []Period
}

// Slots lists every cell in a fixed order: weekday, then period sequence.
func (g Grid) Slots() []Slot {
	days := append([]int(nil), g.Weekdays...)
	sort.Ints(days)
	ps := append([]Period(nil), g.Periods...)
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].Sequence < ps[j].Sequence })

	out := make([]Slot, 0, len(days)*len(ps))
	for _, d := range days {
		for _, p := range ps {
			out = append(out, Slot{Weekday: d, PeriodID: p.ID})
		}
	}
	return out
}

// Requirement is one section's weekly demand for one subject.
//
// TeacherID may be empty. A school knows Class 8B needs six Maths periods
// before it has hired the Maths teacher, and a draft that refuses to place the
// period at all is less useful than one that places it and says the slot is
// unstaffed.
type Requirement struct {
	SectionID      string
	SectionName    string
	ClassSubjectID string
	SubjectName    string
	TeacherID      string
	PeriodsPerWeek int

	// MaxPerDay caps how many periods of this subject one day may hold. Zero
	// derives it: the demand spread evenly over the teaching week, which is
	// one period a day for a five-period subject and two for a nine.
	MaxPerDay int

	// Difficult pulls the subject towards the start of the day. Maths before
	// lunch and Art after it is not a preference a solver can infer.
	Difficult bool
}

// Teacher is one member of staff as the generator sees them: what they may
// not do, and how much of it they may do.
//
// Committed is the load this run does not control — periods in sections
// outside the draft, or a fixed assembly duty. They consume the teacher's caps
// and block their slots exactly as a placement made here would.
type Teacher struct {
	UserID      string
	Name        string
	MaxPerDay   int
	MaxPerWeek  int
	Unavailable []Slot
	Committed   []Slot
}

// Input is everything Generate is allowed to know.
type Input struct {
	Grid         Grid
	Requirements []Requirement
	Teachers     []Teacher

	// Seed fixes every tie-break. The same seed and the same input give the
	// same timetable; a different seed gives a different candidate for the
	// same constraints, which is what "generate another option" means.
	Seed int64

	// RetryBudget bounds the repair work — how many already-placed periods may
	// be moved out of the way to fit a later one. Zero means the default;
	// negative means none, which makes the run strictly greedy.
	RetryBudget int
}

// Placement is one period of the draft.
type Placement struct {
	SectionID      string `json:"section_id"`
	SectionName    string `json:"section_name"`
	ClassSubjectID string `json:"class_subject_id"`
	SubjectName    string `json:"subject_name"`
	TeacherID      string `json:"teacher_id,omitempty"`
	Weekday        int    `json:"weekday"`
	PeriodID       string `json:"period_id"`
}

// Issue kinds. Blocking means a requirement was not met; the rest are things
// the reviewer should look at before publishing.
const (
	// IssueUnmet — fewer periods placed than the section needs.
	IssueUnmet = "unmet_periods"
	// IssueNoTeacher — periods placed, but nobody is assigned to teach them.
	IssueNoTeacher = "no_teacher"
	// IssueTeacherOversubscribed — this teacher's total demand across every
	// section exceeds their weekly cap before a single period is placed.
	IssueTeacherOversubscribed = "teacher_oversubscribed"
	// IssueSectionOversubscribed — the section's subjects want more periods
	// than the week has cells.
	IssueSectionOversubscribed = "section_oversubscribed"
	// IssueStacked — the subject had to exceed its even daily spread.
	IssueStacked = "subject_stacked"
)

const (
	// SeverityBlocking marks a requirement that is not satisfied. A draft
	// carrying one of these is not publishable without a human decision.
	SeverityBlocking = "blocking"
	// SeverityWarning marks a soft preference that had to bend.
	SeverityWarning = "warning"
)

// Issue is one line of the failure report.
type Issue struct {
	Kind     string `json:"kind"`
	Severity string `json:"severity"`

	SectionID      string `json:"section_id,omitempty"`
	SectionName    string `json:"section_name,omitempty"`
	ClassSubjectID string `json:"class_subject_id,omitempty"`
	SubjectName    string `json:"subject_name,omitempty"`
	TeacherID      string `json:"teacher_id,omitempty"`
	TeacherName    string `json:"teacher_name,omitempty"`

	Required int `json:"required"`
	Placed   int `json:"placed"`

	// Detail is the sentence the screen prints. It names the binding
	// constraint, because "6 required, 4 placed" tells the reader nothing they
	// can act on and "the only Maths teacher is at 34 of 35 periods" tells
	// them to hire or to move a period.
	Detail string `json:"detail"`
}

// Result is the candidate and the honest account of it.
type Result struct {
	Placements []Placement
	Issues     []Issue

	// Required and Placed are the whole-run totals. Placed < Required always
	// has at least one blocking issue explaining it.
	Required int
	Placed   int

	// Moves is how much of the retry budget the repair pass spent. Useful only
	// for tuning; a run that spends its whole budget is a run whose input is
	// tighter than it looks.
	Moves int
}

// Blocking reports whether any requirement went unmet.
func (r Result) Blocking() bool {
	for _, i := range r.Issues {
		if i.Severity == SeverityBlocking {
			return true
		}
	}
	return false
}

// Why a candidate slot was rejected. Counted per requirement so the failure
// report can name the constraint that actually did the blocking rather than
// the first one checked.
const (
	blkSectionBusy = iota
	blkTeacherBusy
	blkUnavailable
	blkDayCap
	blkWeekCap
	blkStacking
	blkReasons
)

var blockerNames = [blkReasons]string{
	"the section is already teaching something in every remaining slot",
	"the teacher is already taking another class in every remaining slot",
	"the teacher is marked unavailable in every remaining slot",
	"the teacher would exceed their daily period limit",
	"the teacher has no room left in their weekly period limit",
	"the subject would have to be stacked more than once a day",
}

type state struct {
	in    Input
	slots []Slot
	seq   map[string]int // period id -> sequence
	rng   *rand.Rand

	// jitter breaks scoring ties. Drawn once per slot from the seeded source
	// so the choice is arbitrary but reproducible.
	jitter map[Slot]int

	teachers map[string]*Teacher

	placements []Placement
	// owner is parallel to placements: which requirement each one satisfies.
	// Needed to unwind a repair move, and never derivable from the placement
	// itself because two requirements can name the same class subject.
	owner []int
	// secAt maps a section's slot to the index of the placement holding it,
	// which is what makes a repair move possible: the blocker is identifiable.
	secAt    map[string]int
	teachAt  map[string]bool
	teachDay map[string]int
	teachWk  map[string]int
	subjDay  map[string]int // requirement index + weekday
	secDay   map[string]int

	remaining []int // per requirement
	placed    []int // per requirement
	blocked   [][blkReasons]int
	stacked   []bool

	moves  int
	budget int
}

func skey(section string, s Slot) string {
	return section + "|" + itoa(s.Weekday) + "|" + s.PeriodID
}
func tkey(teacher string, s Slot) string {
	return teacher + "|" + itoa(s.Weekday) + "|" + s.PeriodID
}
func dkey(id string, weekday int) string { return id + "|" + itoa(weekday) }
func rkey(req, weekday int) string       { return itoa(req) + "|" + itoa(weekday) }

func itoa(i int) string { return fmt.Sprintf("%d", i) }

/*
Generate produces one candidate timetable and the report on what it could not do.

	The shape is greedy placement with a bounded repair pass, which is the
	right complexity for a school: a few hundred periods, a handful of hard
	constraints, and a human who is going to edit the result anyway. A proper
	solver library would buy a better objective value and cost the school an
	answer it cannot explain.

	Units are placed round-robin — every requirement takes one period, then
	every requirement takes its second — rather than filling one subject's
	whole allocation before starting the next. Filling in order is what
	produces a Monday made entirely of Maths.
*/
func Generate(in Input) Result {
	st := newState(in)
	res := Result{Placements: []Placement{}, Issues: []Issue{}}

	// Pre-checks first. A section wanting 45 periods in a 40-cell week and a
	// teacher owing 42 periods against a 35-period cap are facts about the
	// input, and reporting them after a failed run buries the cause under its
	// symptoms.
	res.Issues = append(res.Issues, st.preflight()...)

	order := st.requirementOrder()
	for _, r := range in.Requirements {
		res.Required += r.PeriodsPerWeek
	}

	// Round-robin. maxRounds is the largest single demand, so every
	// requirement gets as many attempts as it has periods to place.
	maxRounds := 0
	for _, r := range in.Requirements {
		if r.PeriodsPerWeek > maxRounds {
			maxRounds = r.PeriodsPerWeek
		}
	}
	for round := 0; round < maxRounds; round++ {
		for _, ri := range order {
			if st.remaining[ri] <= 0 {
				continue
			}
			st.placeOne(ri)
		}
	}

	res.Placements = live(st.placements)
	res.Moves = st.moves
	for _, p := range st.placed {
		res.Placed += p
	}
	res.Issues = append(res.Issues, st.report()...)
	sortIssues(res.Issues)
	sortPlacements(res.Placements)
	return res
}

func newState(in Input) *state {
	st := &state{
		in:       in,
		slots:    in.Grid.Slots(),
		seq:      map[string]int{},
		rng:      rand.New(rand.NewSource(in.Seed)),
		jitter:   map[Slot]int{},
		teachers: map[string]*Teacher{},
		secAt:    map[string]int{},
		teachAt:  map[string]bool{},
		teachDay: map[string]int{},
		teachWk:  map[string]int{},
		subjDay:  map[string]int{},
		secDay:   map[string]int{},
		budget:   in.RetryBudget,
	}
	if st.budget == 0 {
		// Enough to unstick a normal week without letting a pathological input
		// spin: two moves per period the run is trying to place.
		total := 0
		for _, r := range in.Requirements {
			total += r.PeriodsPerWeek
		}
		st.budget = 2 * total
	}
	if st.budget < 0 {
		st.budget = 0
	}

	for _, p := range in.Grid.Periods {
		st.seq[p.ID] = p.Sequence
	}
	for _, s := range st.slots {
		st.jitter[s] = st.rng.Intn(1024)
	}
	for i := range in.Teachers {
		t := in.Teachers[i]
		// An unset cap is "no cap the generator knows of", which is the whole
		// week — not zero, which would place nothing and report every subject
		// as unstaffable.
		if t.MaxPerWeek <= 0 {
			t.MaxPerWeek = len(st.slots)
		}
		if t.MaxPerDay <= 0 {
			t.MaxPerDay = len(in.Grid.Periods)
		}
		st.teachers[t.UserID] = &t
		for _, s := range t.Committed {
			st.teachAt[tkey(t.UserID, s)] = true
			st.teachDay[dkey(t.UserID, s.Weekday)]++
			st.teachWk[t.UserID]++
		}
	}

	n := len(in.Requirements)
	st.remaining = make([]int, n)
	st.placed = make([]int, n)
	st.blocked = make([][blkReasons]int, n)
	st.stacked = make([]bool, n)
	for i, r := range in.Requirements {
		st.remaining[i] = r.PeriodsPerWeek
	}
	return st
}

// dayCap is the requirement's declared per-day limit, or the even spread.
func (st *state) dayCap(ri int) int {
	r := st.in.Requirements[ri]
	if r.MaxPerDay > 0 {
		return r.MaxPerDay
	}
	days := len(st.in.Grid.Weekdays)
	if days == 0 {
		return 1
	}
	c := (r.PeriodsPerWeek + days - 1) / days
	if c < 1 {
		c = 1
	}
	return c
}

/*
requirementOrder puts the most constrained requirement first.

	"Most constrained" is demand divided by room: a teacher who owes eight
	periods and is free in twelve slots must be placed before one who owes four
	and is free in thirty, or the second will have taken the slots the first
	needed. Ties fall back to the section and subject name so the order does
	not depend on the caller's map iteration.
*/
func (st *state) requirementOrder() []int {
	type scored struct {
		idx     int
		tension float64
		req     Requirement
	}
	list := make([]scored, 0, len(st.in.Requirements))
	for i, r := range st.in.Requirements {
		room := len(st.slots)
		if t, ok := st.teachers[r.TeacherID]; ok {
			room = 0
			un := map[Slot]bool{}
			for _, s := range t.Unavailable {
				un[s] = true
			}
			for _, s := range st.slots {
				if !un[s] && !st.teachAt[tkey(t.UserID, s)] {
					room++
				}
			}
			if t.MaxPerWeek < room {
				room = t.MaxPerWeek
			}
		}
		tension := float64(r.PeriodsPerWeek)
		if room > 0 {
			tension = float64(r.PeriodsPerWeek) / float64(room)
		} else {
			tension = 1000
		}
		list = append(list, scored{idx: i, tension: tension, req: r})
	}
	sort.SliceStable(list, func(a, b int) bool {
		if list[a].tension != list[b].tension {
			return list[a].tension > list[b].tension
		}
		// Difficult subjects choose first among equals. Scoring alone cannot
		// deliver "Maths before lunch": whichever subject is placed first
		// takes the first period, and the scorer never gets to compare them.
		if list[a].req.Difficult != list[b].req.Difficult {
			return list[a].req.Difficult
		}
		if list[a].req.SectionName != list[b].req.SectionName {
			return list[a].req.SectionName < list[b].req.SectionName
		}
		if list[a].req.SubjectName != list[b].req.SubjectName {
			return list[a].req.SubjectName < list[b].req.SubjectName
		}
		return list[a].req.ClassSubjectID < list[b].req.ClassSubjectID
	})
	out := make([]int, len(list))
	for i, s := range list {
		out[i] = s.idx
	}
	return out
}

// blockers reports why a slot cannot take one period of requirement ri, or -1
// if it can. slack relaxes the per-day stacking cap only.
func (st *state) blockers(ri int, s Slot, slack int) int {
	r := st.in.Requirements[ri]
	if _, taken := st.secAt[skey(r.SectionID, s)]; taken {
		return blkSectionBusy
	}
	// Teacher constraints are tested before the stacking cap on purpose. Both
	// may be true of the same slot and only one gets counted; the teacher's is
	// the one worth reporting, because stacking is a preference this run will
	// relax by itself and a teacher at their cap is not.
	if t, ok := st.teachers[r.TeacherID]; ok {
		if st.teachAt[tkey(t.UserID, s)] {
			return blkTeacherBusy
		}
		for _, u := range t.Unavailable {
			if u == s {
				return blkUnavailable
			}
		}
		if st.teachWk[t.UserID] >= t.MaxPerWeek {
			return blkWeekCap
		}
		if st.teachDay[dkey(t.UserID, s.Weekday)] >= t.MaxPerDay {
			return blkDayCap
		}
	}
	if st.subjDay[rkey(ri, s.Weekday)] >= st.dayCap(ri)+slack {
		return blkStacking
	}
	return -1
}

/*
score ranks a feasible slot; lower is better.

	The weights are ordered by how much a school notices the difference.
	Stacking a subject twice in one day is the complaint that arrives first, so
	it dominates. A stranded free period costs a teacher an hour in the staff
	room between two classes and is worth avoiding but not worth wrecking the
	spread for. The period-of-day term is small and only applies to subjects
	the school marked difficult.
*/
func (st *state) score(ri int, s Slot) int {
	r := st.in.Requirements[ri]
	sc := 0
	sc += 1000 * st.subjDay[rkey(ri, s.Weekday)]
	sc += 40 * st.secDay[dkey(r.SectionID, s.Weekday)]

	if t, ok := st.teachers[r.TeacherID]; ok {
		sc += 30 * st.teachDay[dkey(t.UserID, s.Weekday)]
		sc += 60 * st.gapDelta(t.UserID, s)
	}
	if r.Difficult {
		sc += 12 * st.seq[s.PeriodID]
	} else {
		// A mild pull towards the middle of the day for everything else, so
		// the first period is not always the same three subjects.
		sc += 2 * st.seq[s.PeriodID]
	}
	sc = sc*1024 + st.jitter[s]
	return sc
}

/*
gapDelta is how many stranded free periods placing here would create.

	A free period between two classes is the one a teacher cannot use for
	anything — too short to mark a set of books, too long to wait. Counted as
	isolated free cells strictly inside the teacher's occupied span for the
	day: a free period at either end of the day is going home early or coming
	in late, which nobody complains about.
*/
func (st *state) gapDelta(teacher string, s Slot) int {
	before := st.gaps(teacher, s.Weekday, "")
	after := st.gaps(teacher, s.Weekday, s.PeriodID)
	return after - before
}

func (st *state) gaps(teacher string, weekday int, extra string) int {
	ps := append([]Period(nil), st.in.Grid.Periods...)
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].Sequence < ps[j].Sequence })

	busy := make([]bool, len(ps))
	first, last := -1, -1
	for i, p := range ps {
		if st.teachAt[tkey(teacher, Slot{Weekday: weekday, PeriodID: p.ID})] || p.ID == extra {
			busy[i] = true
			if first < 0 {
				first = i
			}
			last = i
		}
	}
	if first < 0 {
		return 0
	}
	n := 0
	for i := first + 1; i < last; i++ {
		if !busy[i] {
			n++
		}
	}
	return n
}

// placeOne places a single period of requirement ri, relaxing the stacking cap
// and then attempting a repair move before giving up.
func (st *state) placeOne(ri int) bool {
	for _, slack := range []int{0, 1, len(st.in.Grid.Periods)} {
		if st.tryPlace(ri, slack) {
			if slack > 0 {
				st.stacked[ri] = true
			}
			return true
		}
	}
	return st.repair(ri)
}

func (st *state) tryPlace(ri int, slack int) bool {
	best, bestScore := -1, 0
	for i, s := range st.slots {
		if b := st.blockers(ri, s, slack); b >= 0 {
			if slack == 0 {
				st.blocked[ri][b]++
			}
			continue
		}
		sc := st.score(ri, s)
		if best < 0 || sc < bestScore {
			best, bestScore = i, sc
		}
	}
	if best < 0 {
		return false
	}
	st.commit(ri, st.slots[best])
	return true
}

func (st *state) commit(ri int, s Slot) {
	r := st.in.Requirements[ri]
	idx := len(st.placements)
	st.placements = append(st.placements, Placement{
		SectionID:      r.SectionID,
		SectionName:    r.SectionName,
		ClassSubjectID: r.ClassSubjectID,
		SubjectName:    r.SubjectName,
		TeacherID:      r.TeacherID,
		Weekday:        s.Weekday,
		PeriodID:       s.PeriodID,
	})
	st.secAt[skey(r.SectionID, s)] = idx
	st.secDay[dkey(r.SectionID, s.Weekday)]++
	st.subjDay[rkey(ri, s.Weekday)]++
	if r.TeacherID != "" {
		st.teachAt[tkey(r.TeacherID, s)] = true
		st.teachDay[dkey(r.TeacherID, s.Weekday)]++
		st.teachWk[r.TeacherID]++
	}
	st.remaining[ri]--
	st.placed[ri]++
	// The placement's owning requirement, needed to unwind a repair move.
	st.owner = append(st.owner, ri)
}

func (st *state) uncommit(idx int) {
	p := st.placements[idx]
	ri := st.owner[idx]
	s := Slot{Weekday: p.Weekday, PeriodID: p.PeriodID}
	delete(st.secAt, skey(p.SectionID, s))
	st.secDay[dkey(p.SectionID, s.Weekday)]--
	st.subjDay[rkey(ri, s.Weekday)]--
	if p.TeacherID != "" {
		delete(st.teachAt, tkey(p.TeacherID, s))
		st.teachDay[dkey(p.TeacherID, s.Weekday)]--
		st.teachWk[p.TeacherID]--
	}
	st.remaining[ri]++
	st.placed[ri]--
	// Tombstone rather than reslice: every index held in secAt would otherwise
	// shift, and a repair that corrupts that map is worse than an unplaced
	// period. Empty SectionID marks the hole; live() drops them at the end.
	st.placements[idx].SectionID = ""
}

/*
repair is the bounded backtracking step.

	Only one shape of move is attempted, because it is the one that pays: a
	slot this requirement could use is held by another subject of the *same
	section*, and that subject has somewhere else to go. Lift it, place ours,
	put it back down elsewhere. If it will not go back down, undo the whole
	thing — a repair that leaves the timetable worse than it found it is how a
	generator loses periods without reporting them.
*/
func (st *state) repair(ri int) bool {
	if st.moves >= st.budget {
		return false
	}
	r := st.in.Requirements[ri]
	slack := len(st.in.Grid.Periods)

	for _, s := range st.slots {
		holder, taken := st.secAt[skey(r.SectionID, s)]
		if !taken {
			continue
		}
		// The slot must be usable by us once the holder steps out of it.
		blockedBySomethingElse := false
		if t, ok := st.teachers[r.TeacherID]; ok {
			if st.teachAt[tkey(t.UserID, s)] ||
				st.teachDay[dkey(t.UserID, s.Weekday)] >= t.MaxPerDay ||
				st.teachWk[t.UserID] >= t.MaxPerWeek {
				blockedBySomethingElse = true
			}
			for _, u := range t.Unavailable {
				if u == s {
					blockedBySomethingElse = true
				}
			}
		}
		if blockedBySomethingElse {
			continue
		}

		hri := st.owner[holder]
		st.moves++
		st.uncommit(holder)
		if !st.tryPlace(ri, slack) {
			// Could not use the slot after all; put the holder back where it
			// was and move on.
			st.commit(hri, s)
			if st.moves >= st.budget {
				return false
			}
			continue
		}
		if st.tryPlace(hri, slack) {
			return true
		}
		// Ours went in, theirs will not go anywhere: strictly a wash at best
		// and a loss if the holder had nowhere else. Undo both.
		st.uncommit(len(st.placements) - 1)
		st.commit(hri, s)
		if st.moves >= st.budget {
			return false
		}
	}
	return false
}

/*
preflight names the impossibilities that are visible before anything is placed.

	Both of these produce a pile of confusing per-subject failures if left to
	be discovered during placement. A teacher owing 42 periods against a
	35-period cap will fail seven times against seven different subjects, and
	the reader has to add them up to see the one real problem.
*/
func (st *state) preflight() []Issue {
	out := []Issue{}

	// Demand per teacher against their weekly cap.
	type demand struct {
		periods  int
		subjects []string
	}
	byTeacher := map[string]*demand{}
	for _, r := range st.in.Requirements {
		if r.TeacherID == "" {
			continue
		}
		d := byTeacher[r.TeacherID]
		if d == nil {
			d = &demand{}
			byTeacher[r.TeacherID] = d
		}
		d.periods += r.PeriodsPerWeek
		d.subjects = append(d.subjects, r.SectionName+" "+r.SubjectName)
	}
	ids := make([]string, 0, len(byTeacher))
	for id := range byTeacher {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		t, ok := st.teachers[id]
		if !ok {
			continue
		}
		d := byTeacher[id]
		committed := len(t.Committed)
		if d.periods+committed <= t.MaxPerWeek {
			continue
		}
		sort.Strings(d.subjects)
		out = append(out, Issue{
			Kind:        IssueTeacherOversubscribed,
			Severity:    SeverityBlocking,
			TeacherID:   id,
			TeacherName: t.Name,
			Required:    d.periods + committed,
			Placed:      t.MaxPerWeek,
			Detail: fmt.Sprintf(
				"%s is asked for %d periods a week (%d here, %d already committed) against a cap of %d. %s cannot all be staffed by them.",
				nameOr(t.Name, "This teacher"), d.periods+committed, d.periods, committed, t.MaxPerWeek,
				joinShort(d.subjects, 3)),
		})
	}

	// Demand per section against the size of the week.
	type sdemand struct {
		name    string
		periods int
	}
	bySection := map[string]*sdemand{}
	for _, r := range st.in.Requirements {
		d := bySection[r.SectionID]
		if d == nil {
			d = &sdemand{name: r.SectionName}
			bySection[r.SectionID] = d
		}
		d.periods += r.PeriodsPerWeek
	}
	sids := make([]string, 0, len(bySection))
	for id := range bySection {
		sids = append(sids, id)
	}
	sort.Strings(sids)
	cells := len(st.slots)
	for _, id := range sids {
		d := bySection[id]
		if d.periods <= cells {
			continue
		}
		out = append(out, Issue{
			Kind:        IssueSectionOversubscribed,
			Severity:    SeverityBlocking,
			SectionID:   id,
			SectionName: d.name,
			Required:    d.periods,
			Placed:      cells,
			Detail: fmt.Sprintf(
				"%s needs %d periods a week and the timetable has %d teaching slots. %d periods cannot be placed anywhere.",
				nameOr(d.name, "This section"), d.periods, cells, d.periods-cells),
		})
	}
	return out
}

// report turns what happened into the sentences the screen prints.
func (st *state) report() []Issue {
	out := []Issue{}
	for i, r := range st.in.Requirements {
		if st.placed[i] > 0 && r.TeacherID == "" {
			out = append(out, Issue{
				Kind: IssueNoTeacher, Severity: SeverityWarning,
				SectionID: r.SectionID, SectionName: r.SectionName,
				ClassSubjectID: r.ClassSubjectID, SubjectName: r.SubjectName,
				Required: r.PeriodsPerWeek, Placed: st.placed[i],
				Detail: fmt.Sprintf("%s %s has %d periods in the draft and no teacher assigned to any of them.",
					r.SectionName, r.SubjectName, st.placed[i]),
			})
		}
		if st.stacked[i] {
			out = append(out, Issue{
				Kind: IssueStacked, Severity: SeverityWarning,
				SectionID: r.SectionID, SectionName: r.SectionName,
				ClassSubjectID: r.ClassSubjectID, SubjectName: r.SubjectName,
				Required: r.PeriodsPerWeek, Placed: st.placed[i],
				Detail: fmt.Sprintf("%s %s had to be doubled up on a day to fit its %d periods.",
					r.SectionName, r.SubjectName, r.PeriodsPerWeek),
			})
		}
		if st.remaining[i] <= 0 {
			continue
		}
		out = append(out, Issue{
			Kind: IssueUnmet, Severity: SeverityBlocking,
			SectionID: r.SectionID, SectionName: r.SectionName,
			ClassSubjectID: r.ClassSubjectID, SubjectName: r.SubjectName,
			TeacherID:   r.TeacherID,
			TeacherName: st.teacherName(r.TeacherID),
			Required:    r.PeriodsPerWeek, Placed: st.placed[i],
			Detail: st.explain(i),
		})
	}
	return out
}

/*
explain names the constraint that actually did the blocking.

	Every rejected slot was counted by reason during the first, unrelaxed pass.
	The reason with the most rejections is the one to print: it is what the
	reader has to change. Where the teacher is the binding constraint the
	sentence carries their current load against their cap, because that is the
	number the answer depends on — hire, or move a period off them.
*/
func (st *state) explain(ri int) string {
	r := st.in.Requirements[ri]
	short := r.PeriodsPerWeek - st.placed[ri]
	head := fmt.Sprintf("%s needs %d %s %s; %d placed, %d short.",
		nameOr(r.SectionName, "This section"), r.PeriodsPerWeek, r.SubjectName,
		plural("period", r.PeriodsPerWeek), st.placed[ri], short)

	// The teacher's final state beats any count. If they finished the run at
	// their weekly cap, that is the answer whatever the per-slot tally says —
	// and it is the sentence that decides whether the school hires or moves a
	// period off somebody.
	if t, ok := st.teachers[r.TeacherID]; ok {
		if st.teachWk[t.UserID] >= t.MaxPerWeek {
			return fmt.Sprintf("%s %s is at %d of %d periods for the week and cannot take more.",
				head, nameOr(t.Name, "The assigned teacher"), st.teachWk[t.UserID], t.MaxPerWeek)
		}
		full := 0
		for _, d := range st.in.Grid.Weekdays {
			if st.teachDay[dkey(t.UserID, d)] >= t.MaxPerDay {
				full++
			}
		}
		if full == len(st.in.Grid.Weekdays) && full > 0 {
			return fmt.Sprintf("%s %s is at their daily limit of %d periods on every day of the week.",
				head, nameOr(t.Name, "The assigned teacher"), t.MaxPerDay)
		}
	}

	worst, worstN := -1, 0
	for k, n := range st.blocked[ri] {
		if n > worstN {
			worst, worstN = k, n
		}
	}
	if worst < 0 {
		return head + " No slot in the week could take it."
	}
	if t, ok := st.teachers[r.TeacherID]; ok &&
		(worst == blkTeacherBusy || worst == blkUnavailable) {
		return fmt.Sprintf("%s %s: %s.", head,
			nameOr(t.Name, "The assigned teacher"), blockerNames[worst])
	}
	return head + " " + upperFirst(blockerNames[worst]) + "."
}

func (st *state) teacherName(id string) string {
	if t, ok := st.teachers[id]; ok {
		return t.Name
	}
	return ""
}

// --- small helpers -----------------------------------------------------------

func nameOr(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func plural(word string, n int) string {
	if n == 1 {
		return word
	}
	return word + "s"
}

func upperFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func joinShort(items []string, n int) string {
	if len(items) == 0 {
		return ""
	}
	if len(items) <= n {
		return strings.Join(items, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(items[:n], ", "), len(items)-n)
}

func sortIssues(is []Issue) {
	sort.SliceStable(is, func(a, b int) bool {
		if (is[a].Severity == SeverityBlocking) != (is[b].Severity == SeverityBlocking) {
			return is[a].Severity == SeverityBlocking
		}
		if is[a].SectionName != is[b].SectionName {
			return is[a].SectionName < is[b].SectionName
		}
		if is[a].SubjectName != is[b].SubjectName {
			return is[a].SubjectName < is[b].SubjectName
		}
		return is[a].Kind < is[b].Kind
	})
}

// live drops the tombstones a repair move left behind.
func live(ps []Placement) []Placement {
	out := make([]Placement, 0, len(ps))
	for _, p := range ps {
		if p.SectionID != "" {
			out = append(out, p)
		}
	}
	return out
}

func sortPlacements(ps []Placement) {
	sort.SliceStable(ps, func(a, b int) bool {
		if ps[a].SectionName != ps[b].SectionName {
			return ps[a].SectionName < ps[b].SectionName
		}
		if ps[a].SectionID != ps[b].SectionID {
			return ps[a].SectionID < ps[b].SectionID
		}
		if ps[a].Weekday != ps[b].Weekday {
			return ps[a].Weekday < ps[b].Weekday
		}
		return ps[a].PeriodID < ps[b].PeriodID
	})
}
