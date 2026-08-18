package api

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Authorization for the six student-life screens, asserted on the router that
production builds rather than on a restatement of it.

	These routes mount inside the /portal group, whose permission is
	self.profile.read -- a permission every role in the product holds, including
	the child. So the router can only prove one half of the property, and it is
	important to be precise about which half:

	  - The staff acts inside these screens (moderating the wall, taking a
	    thread down, calling on a raised hand, reading the engagement report)
	    ARE guarded by a permission, and the tests below prove a child holding
	    only self.profile.read is refused all of them.

	  - Everything a child does -- posting, claiming, writing a diary note --
	    is NOT guarded by a permission and must not be. What stands between one
	    child and another child's data there is portalChild resolving every
	    student id against the caller's own resolved scope inside the handler,
	    and the last test in this file asserts the property that makes that
	    check reachable: those routes let the request through to the handler
	    rather than being refused or, worse, silently open to staff-only work.

	identityWith and statusOf already exist in this package
	(fee_engine_authz_test.go) and are reused rather than redeclared.
*/

func mountedStudentLife(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountStudentLife(r)
	return r
}

// The wall's moderation surface. Publishing what children write about children
// is comms.announcements.write and nothing less.
var wallModerationRoutes = []struct{ method, path string }{
	{http.MethodGet, "/campus/wall/queue"},
	{http.MethodPost, "/campus/wall/" + uuid.NewString() + "/moderate"},
	{http.MethodGet, "/campus/wall/" + uuid.NewString() + "/history"},
}

// The teacher's half of the homework forum and the hand-raise record.
var teachingSupervisionRoutes = []struct{ method, path string }{
	{http.MethodGet, "/homework/forum/supervision"},
	{http.MethodPost, "/homework/forum/threads/" + uuid.NewString() + "/remove"},
	{http.MethodPost, "/homework/forum/posts/" + uuid.NewString() + "/remove"},
	{http.MethodGet, "/live-classes/" + uuid.NewString() + "/hands"},
	{http.MethodPost, "/live-classes/hands/" + uuid.NewString() + "/call-on"},
	{http.MethodGet, "/live-classes/engagement"},
}

/*
A child cannot moderate the wall they post to.

	This is the sharpest failure available in the whole feature: a pupil who
	could approve their own pending post has defeated pre-moderation entirely,
	and one who could reach the queue can read every unapproved thing every
	other child has written about them. self.profile.read is what a child holds
	and it must buy neither.
*/
func TestStudentLifeRefusesWallModerationToAChild(t *testing.T) {
	h := mountedStudentLife(identityWith(rbac.SelfProfileRead))

	for _, tc := range wallModerationRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a child must not moderate the wall",
				tc.method, tc.path, got)
		}
	}
}

/*
A child cannot read the supervision or engagement screens.

	The forum supervision list carries every thread on a teacher's homework,
	including replies withheld from students until the due date; the engagement
	report names which children never raise a hand. Both are adult views of
	children and neither is reachable on a pupil's own permission.
*/
func TestStudentLifeRefusesSupervisionToAChild(t *testing.T) {
	h := mountedStudentLife(identityWith(rbac.SelfProfileRead))

	for _, tc := range teachingSupervisionRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a child must not hold the teacher's view",
				tc.method, tc.path, got)
		}
	}
}

/*
The two staff authorities are separate and neither implies the other.

	A class teacher holding academics.homework.write supervises the forum and
	calls on raised hands, but publishing to the school wall is a communications
	act the school may withhold from them. The reverse matters more: the office
	clerk who moderates the wall holds comms.announcements.write and has no
	business reading a section's homework discussion or its engagement report.

	Asserting this stops the two groups being quietly merged into one
	permission during a later refactor, which is how a moderation surface ends
	up open to everyone who can do anything.
*/
func TestStudentLifeKeepsWallAndTeachingAuthoritiesApart(t *testing.T) {
	moderator := mountedStudentLife(identityWith(rbac.SelfProfileRead, rbac.AnnouncementsWrite))
	for _, tc := range teachingSupervisionRoutes {
		if got := statusOf(t, moderator, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — moderating the wall is not teaching a class",
				tc.method, tc.path, got)
		}
	}

	teacher := mountedStudentLife(identityWith(rbac.SelfProfileRead, rbac.HomeworkWrite))
	for _, tc := range wallModerationRoutes {
		if got := statusOf(t, teacher, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — setting homework is not publishing to the wall",
				tc.method, tc.path, got)
		}
	}
}

// Holding the right permission gets past the door. Not a claim that the
// handler then permits anything -- it reaches a nil *database.DB and panics,
// which statusOf reports as 500 -- only that the guard is not refusing the role
// the feature is for.
func TestStudentLifeAdmitsTheIntendedStaffRoles(t *testing.T) {
	moderator := mountedStudentLife(identityWith(rbac.SelfProfileRead, rbac.AnnouncementsWrite))
	for _, tc := range wallModerationRoutes {
		if got := statusOf(t, moderator, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s: 403 for comms.announcements.write, which is the permission this route is for",
				tc.method, tc.path)
		}
	}

	teacher := mountedStudentLife(identityWith(rbac.SelfProfileRead, rbac.HomeworkWrite))
	for _, tc := range teachingSupervisionRoutes {
		if got := statusOf(t, teacher, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s: 403 for academics.homework.write, which is the permission this route is for",
				tc.method, tc.path)
		}
	}
}

/*
The child's own routes reach the handler, because that is where the real check
is.

	Every route here takes a student id from the caller and every one of them
	resolves it through portalChild before touching a row. If the router
	refused these, the ownership check would never run and the screens would not
	work; if a permission were bolted onto them, the check would look redundant
	and the next agent would delete it. So the property asserted is exactly
	"not 403": the request arrives at the handler, where scope decides.

	The scope decision itself is a database property -- portalChild answers 404
	for a student the caller does not own -- and cannot be reached without one.
*/
func TestStudentLifeLetsAChildReachTheOwnershipCheck(t *testing.T) {
	h := mountedStudentLife(identityWith(rbac.SelfProfileRead))

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/campus/wall"},
		{http.MethodPost, "/campus/wall"},
		{http.MethodPost, "/campus/wall/" + uuid.NewString() + "/report"},
		{http.MethodGet, "/campus/lost-found/" + uuid.NewString() + "/claims"},
		{http.MethodPost, "/campus/lost-found/" + uuid.NewString() + "/claims"},
		{http.MethodPost, "/campus/lost-found/claims/" + uuid.NewString() + "/decide"},
		{http.MethodPost, "/campus/lost-found/claims/" + uuid.NewString() + "/withdraw"},
		{http.MethodPost, "/campus/lost-found/" + uuid.NewString() + "/photo"},
		{http.MethodGet, "/diary"},
		{http.MethodGet, "/diary/notes"},
		{http.MethodPost, "/diary/notes"},
		{http.MethodPost, "/diary/notes/" + uuid.NewString()},
		{http.MethodDelete, "/diary/notes/" + uuid.NewString()},
		{http.MethodGet, "/preferences/display"},
		{http.MethodPut, "/preferences/display"},
		{http.MethodGet, "/homework/forum/threads"},
		{http.MethodPost, "/homework/forum/threads"},
		{http.MethodGet, "/homework/forum/threads/" + uuid.NewString()},
		{http.MethodPost, "/homework/forum/threads/" + uuid.NewString() + "/posts"},
		{http.MethodPost, "/homework/forum/threads/" + uuid.NewString() + "/resolve"},
		{http.MethodGet, "/live-classes"},
		{http.MethodPost, "/live-classes/" + uuid.NewString() + "/hand"},
		{http.MethodPost, "/live-classes/" + uuid.NewString() + "/hand/lower"},
		{http.MethodGet, "/live-classes/my-engagement"},
	} {
		got := statusOf(t, h, tc.method, tc.path)
		if got == http.StatusForbidden {
			t.Errorf("%s %s: 403 — a child's own screen must reach the ownership check, not be refused at the door",
				tc.method, tc.path)
		}
		if got == http.StatusNotFound || got == http.StatusMethodNotAllowed {
			t.Errorf("%s %s: %d — the route is not mounted", tc.method, tc.path, got)
		}
	}
}

/*
The display-preference API offers only what the stylesheet implements.

	The product owner has frozen visual change, so the selector is allowed to
	exist only because every value it can store is already rendered by
	web/src/index.css: a light palette on :root, a .dark override, and a
	three-step data-density dial. This test is the guard on that promise --
	adding a fourth theme here without adding the tokens would produce a
	setting that appears to work and does nothing, which is the failure the
	freeze is meant to prevent.

	It also pins the defaults. 'system' and 'comfortable' are what the shell
	does today for a user who has never opened the selector, and a default that
	drifts would silently restyle every existing account.
*/
func TestDisplayPreferencesOfferOnlyImplementedChoices(t *testing.T) {
	if got := len(themeChoices); got != 3 {
		t.Fatalf("themeChoices has %d entries; index.css implements exactly light, dark and follow-the-OS", got)
	}
	for _, want := range []string{"system", "light", "dark"} {
		if !isAllowedChoice(want, themeChoices) {
			t.Errorf("theme %q is missing from themeChoices", want)
		}
	}
	for _, unwanted := range []string{"high_contrast", "sepia", "solarized", ""} {
		if isAllowedChoice(unwanted, themeChoices) {
			t.Errorf("theme %q is offered but no palette for it exists in index.css", unwanted)
		}
	}
	for _, want := range []string{"compact", "comfortable", "relaxed"} {
		if !isAllowedChoice(want, densityChoices) {
			t.Errorf("density %q is missing from densityChoices", want)
		}
	}
	if themeChoices[0] != "system" || densityChoices[1] != "comfortable" {
		t.Error("the defaults returned by getDisplayPreferences must stay 'system' and 'comfortable'")
	}
}

// The wall's rate limit is a number the product depends on, not a tuning knob.
// A limit that drifted upward silently would turn the wall back into a feed.
func TestWallDailyLimitStaysSmall(t *testing.T) {
	if wallDailyLimit < 1 || wallDailyLimit > 5 {
		t.Errorf("wallDailyLimit is %d; an unbounded wall is how one child decides who it is about",
			wallDailyLimit)
	}
}
