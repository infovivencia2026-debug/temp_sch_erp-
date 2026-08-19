package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Reminder plans: the arithmetic that keeps a parent from being chased twice, and
the router that decides who may author a chase at all.

	No database is needed for either. chaseNumber is deliberately a pure
	function of the invoice's age and the school's policy -- that is the
	property that makes the sweep safe to run repeatedly -- and
	RequirePermission runs before any handler, so a refusal never reaches a
	query.
*/

func mountedPlans(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountMessageRules(r)
	return r
}

var planReadRoutes = []struct{ method, path string }{
	{http.MethodGet, "/messaging/plans"},
}

var planWriteRoutes = []struct{ method, path string }{
	{http.MethodPost, "/messaging/plans"},
	{http.MethodDelete, "/messaging/plans/" + uuid.NewString()},
}

var planPreviewRoutes = []struct{ method, path string }{
	{http.MethodPost, "/messaging/plans/" + uuid.NewString() + "/preview"},
}

var planRunRoutes = []struct{ method, path string }{
	{http.MethodPost, "/messaging/plans/" + uuid.NewString() + "/run"},
}

func allPlanRoutes() []struct{ method, path string } {
	var out []struct{ method, path string }
	for _, g := range [][]struct{ method, path string }{
		planReadRoutes, planWriteRoutes, planPreviewRoutes, planRunRoutes,
	} {
		out = append(out, g...)
	}
	return out
}

// A signed-in user holding nothing at all reaches nothing at all — including
// the preview, which names guardians.
func TestPlanRoutesRefuseACallerWithNoPermissions(t *testing.T) {
	h := mountedPlans(identityWith())
	for _, tc := range allPlanRoutes() {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Seeing how the school chases fees is not deciding it, and is not firing it.

	institution.read is the rung every administrator holds. If it also opened
	the save route, any user who could look at the settings screen could set a
	daily WhatsApp chase against every family in the school.
*/
func TestPlanReadRungReachesReadsOnly(t *testing.T) {
	h := mountedPlans(identityWith(rbac.InstitutionRead))
	for _, tc := range planReadRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with institution.read: got 403, want through", tc.method, tc.path)
		}
	}
	for _, tc := range append(append([]struct{ method, path string }{},
		planWriteRoutes...), append(planPreviewRoutes, planRunRoutes...)...) {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only institution.read: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Authoring a plan and firing one are different rungs, deliberately.

	A bursar may configure the fee chase without holding the right to send a
	message to every parent in the school this afternoon. So settings.write
	opens the form and the preview, and only comms.messages.send opens "Run
	now".
*/
func TestPlanAuthoringDoesNotGrantSending(t *testing.T) {
	h := mountedPlans(identityWith(rbac.SettingsWrite))
	for _, tc := range append(append([]struct{ method, path string }{},
		planWriteRoutes...), planPreviewRoutes...) {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with settings.write: got 403, want through", tc.method, tc.path)
		}
	}
	for _, tc := range planRunRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only settings.write: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

// The person who runs communications may preview and fire, but may not rewrite
// the policy.
func TestPlanSendRungPreviewsAndRunsButDoesNotAuthor(t *testing.T) {
	h := mountedPlans(identityWith(rbac.MessagesSend))
	for _, tc := range append(append([]struct{ method, path string }{},
		planPreviewRoutes...), planRunRoutes...) {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with messages.send: got 403, want through", tc.method, tc.path)
		}
	}
	for _, tc := range planWriteRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only messages.send: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

// --- the chase arithmetic ----------------------------------------------------

/*
chaseNumber is where a duplicate fee reminder would come from, so it is pinned
case by case.

	The policy under test throughout is the common one: start at seven days,
	come back weekly, three chases at most.
*/
func TestChaseNumberIsDerivedFromAgeAlone(t *testing.T) {
	const first, repeat, max = 7, 7, 3

	cases := []struct {
		days    int
		attempt int
		want    bool
		why     string
	}{
		{0, 0, false, "not yet due for a first chase"},
		{6, 0, false, "the day before the policy starts"},
		{7, 0, true, "the first chase, on the day the policy names"},
		{8, 0, true, "still the first chase — a sweep on day 8 must not send a second"},
		{13, 0, true, "last day of the first window"},
		{14, 1, true, "second chase"},
		{20, 1, true, "still the second chase"},
		{21, 2, true, "third chase"},
		{27, 2, true, "still the third"},
		{28, 0, false, "the cap: three chases have gone, leave the family alone"},
		{400, 0, false, "long past the cap, and still silent"},
	}
	for _, c := range cases {
		got, ok := chaseNumber(c.days, first, repeat, max)
		if ok != c.want {
			t.Errorf("chaseNumber(%d): sends = %v, want %v (%s)", c.days, ok, c.want, c.why)
			continue
		}
		if ok && got != c.attempt {
			t.Errorf("chaseNumber(%d) = chase %d, want %d (%s)", c.days, got, c.attempt, c.why)
		}
	}
}

/*
The property the whole scheme rests on: every day inside one window produces the
same occurrence key.

	If it did not, the sweep running twice on the same day -- or a worker that
	missed Tuesday and caught up on Wednesday -- would key the second send
	differently, the one-per-occurrence index would not see it as a duplicate,
	and a family would be chased twice about one invoice.
*/
func TestOneChasePerWindowWhateverDayTheSweepRuns(t *testing.T) {
	const first, repeat, max = 7, 7, 4

	seen := map[int]int{}
	for days := 0; days < 7*max+first; days++ {
		if attempt, ok := chaseNumber(days, first, repeat, max); ok {
			seen[attempt]++
		}
	}
	if len(seen) != max {
		t.Fatalf("windows found = %d, want %d", len(seen), max)
	}
	for attempt, days := range seen {
		if days != repeat {
			t.Errorf("chase %d is reachable on %d days, want %d — a window that is not "+
				"a whole repeat period either skips a family or chases one twice",
				attempt, days, repeat)
		}
	}
}

// A plan that never repeats sends exactly once, however long the invoice sits.
func TestNoRepeatMeansOneChaseForever(t *testing.T) {
	sends := 0
	for days := 0; days < 400; days++ {
		if _, ok := chaseNumber(days, 3, 0, 1); ok {
			sends++
		}
	}
	// Every day from 3 onward is chase 0, which is one occurrence key and
	// therefore one message — the index does the collapsing, not this
	// function, which is why the count here is days and not one.
	if sends != 400-3 {
		t.Errorf("chase-0 days = %d, want %d", sends, 400-3)
	}
	if a, ok := chaseNumber(399, 3, 0, 1); !ok || a != 0 {
		t.Errorf("day 399 = chase %d, ok %v; want chase 0 — a plan with no repeat "+
			"must never number a second chase", a, ok)
	}
}

// --- the gate ----------------------------------------------------------------

func TestGateHoldsUntilTheRegisterIsPlausiblyTaken(t *testing.T) {
	at := func(h, m int) time.Time {
		return time.Date(2026, 8, 19, h, m, 0, 0, time.UTC)
	}
	half := "11:30:00"
	p := reminderPlan{Kind: planAbsenceAlert, SendAtTime: &half}

	if open, why := p.gateOpen(at(8, 0)); open {
		t.Error("gate open at 08:00: half the registers are unmarked, so half the school is not yet absent")
	} else if why == "" {
		t.Error("a closed gate must say when it opens — it is the answer to 'why has nothing gone out'")
	}
	if open, _ := p.gateOpen(at(11, 29)); open {
		t.Error("gate open a minute early")
	}
	if open, _ := p.gateOpen(at(11, 30)); !open {
		t.Error("gate still shut at the moment it names")
	}
	if open, _ := p.gateOpen(at(16, 0)); !open {
		t.Error("gate shut in the afternoon")
	}

	// No time set is not a closed gate. A fee chase has none, and a plan whose
	// gate defaulted shut would look configured and never fire.
	var none reminderPlan
	if open, why := none.gateOpen(at(3, 0)); !open || why != "" {
		t.Errorf("plan with no send-after time: open = %v, why = %q; want open", open, why)
	}
}

// --- masking -----------------------------------------------------------------

// The preview names people. It must not become a way to export the school's
// contact list one rule at a time.
func TestMaskAddressKeepsRecognitionAndNotTheNumber(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"9100575183":        "••••••5183",
		"+919100575183":     "•••••••••5183",
		"anita@example.com": "a••••@example.com",
		// A local part of one or two characters is masked whole, and to a fixed
		// width: revealing one of two is revealing half a name, and matching the
		// width would leak which.
		"jo@example.com":      "••@example.com",
		"a@example.com":       "••@example.com",
		"1234":                "••••",
		"  9100575183       ": "••••••5183",
	}
	for in, want := range cases {
		if got := maskAddress(in); got != want {
			t.Errorf("maskAddress(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- the dedupe key ----------------------------------------------------------

/*
The preview's duplicate test has to agree with the index, including where the
index is surprising.

	Two guardians of one child, neither with a portal login, share a key --
	user_id is NULL for both and COALESCE folds them together, so the second
	insert is refused. That is the index working as designed, and it means "14
	guardians" is not 14 messages. A preview that did not model it would
	over-promise by exactly the number of families where both parents are on
	file and neither has signed in.
*/
func TestDedupeKeyFoldsAccountlessGuardiansOfOneChild(t *testing.T) {
	student := uuid.New()
	sub := MessageSubject{StudentID: &student, OccurrenceKey: student.String() + ":2026-08-19"}

	mother := recipient{Name: "Anita", Address: "9100575183"}
	father := recipient{Name: "Ravi", Address: "9100575184"}
	if dedupeKey(sub, mother) != dedupeKey(sub, father) {
		t.Error("two guardians with no accounts got different keys, but the index would " +
			"fold them — the preview would promise a message that is never written")
	}

	uid := uuid.New()
	withLogin := recipient{Name: "Anita", UserID: &uid}
	if dedupeKey(sub, withLogin) == dedupeKey(sub, father) {
		t.Error("a guardian with a portal login must key separately, or one parent's " +
			"message silently replaces the other's")
	}

	// Different chases of one invoice are different occurrences. If they were
	// not, chase two would be refused as a duplicate of chase one and the
	// school would chase every family exactly once, forever.
	inv := uuid.New()
	one := MessageSubject{StudentID: &student, OccurrenceKey: inv.String() + "#0"}
	two := MessageSubject{StudentID: &student, OccurrenceKey: inv.String() + "#1"}
	if dedupeKey(one, mother) == dedupeKey(two, mother) {
		t.Error("chase 1 and chase 2 share a key: the second would never be sent")
	}
}

// --- the plan catalogue ------------------------------------------------------

// Every kind the CHECK constraint in 00103 permits must have an event and a
// finder, or a plan saved through the form is a row that silently never fires.
func TestEveryPlanKindNamesAnEventAFinderKnows(t *testing.T) {
	s := &Server{}
	events := s.knownEvents()
	for _, d := range planCatalogue() {
		if d.Event == "" {
			t.Errorf("plan kind %q names no event", d.Kind)
			continue
		}
		if _, ok := events[d.Event]; !ok {
			t.Errorf("plan kind %q names event %q, which no finder in knownEvents() "+
				"produces — the generic screen would show it as unfirable", d.Kind, d.Event)
		}
		if _, ok := builtinTemplates[d.TemplateCode]; !ok {
			t.Errorf("plan kind %q defaults to template %q, which has no built-in — a "+
				"school with no templates of its own could not send at all", d.Kind, d.TemplateCode)
		}
		if planEventFor(d.Kind) != d.Event {
			t.Errorf("planEventFor(%q) disagrees with the catalogue", d.Kind)
		}
	}
	if planEventFor("nonsense") != "" {
		t.Error("planEventFor accepted a kind the CHECK constraint would refuse")
	}
}
