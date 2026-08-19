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
Authorization for the four communication screens, decided on the router that
production builds rather than on a restatement of it.

	No database is needed: RequirePermission runs before the handler, so a
	refusal never reaches one. identityWith and statusOf already exist in this
	package (fee_engine_authz_test.go) and are reused rather than redeclared.

	The property that matters most is the last group. A counselling thread is
	NOT protected by a permission -- it is protected by a row in
	counselor_thread_participants, checked inside every handler. So the tests
	here can only prove the half that the router owns: that holding a
	counselling, teaching or principal-ish permission does not by itself open
	the route to a thread's contents in place of participation. The other half
	-- that a signed-in non-participant gets 404 from threadRole -- is a
	database property and is asserted by the scope test below reaching the
	handler rather than being turned away at the door.
*/

func mountedComms(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountComms(r)
	return r
}

var commsGrievanceReads = []struct{ method, path string }{
	{http.MethodGet, "/comms/grievances/"},
	{http.MethodGet, "/comms/grievances/summary"},
	{http.MethodGet, "/comms/grievances/" + uuid.NewString()},
	{http.MethodGet, "/comms/grievances/" + uuid.NewString() + "/updates"},
	{http.MethodGet, "/comms/grievance-sla/"},
}

var commsGrievanceWrites = []struct{ method, path string }{
	{http.MethodPut, "/comms/grievances/" + uuid.NewString() + "/triage"},
	{http.MethodPost, "/comms/grievances/" + uuid.NewString() + "/updates"},
	{http.MethodPost, "/comms/grievances/" + uuid.NewString() + "/acknowledge"},
	{http.MethodPost, "/comms/grievances/" + uuid.NewString() + "/escalate"},
	{http.MethodPost, "/comms/grievances/" + uuid.NewString() + "/resolve"},
	{http.MethodPut, "/comms/grievance-sla/"},
}

var commsShowcaseReads = []struct{ method, path string }{
	{http.MethodGet, "/comms/achievements/"},
	{http.MethodGet, "/comms/achievements/" + uuid.NewString()},
}

var commsShowcaseWrites = []struct{ method, path string }{
	{http.MethodPost, "/comms/achievements/"},
	{http.MethodPut, "/comms/achievements/" + uuid.NewString()},
	{http.MethodDelete, "/comms/achievements/" + uuid.NewString()},
	{http.MethodPost, "/comms/achievements/" + uuid.NewString() + "/media"},
	{http.MethodPost, "/comms/achievements/" + uuid.NewString() + "/consent"},
}

var commsPublishRoutes = []struct{ method, path string }{
	{http.MethodPost, "/comms/achievements/" + uuid.NewString() + "/publish"},
	{http.MethodPost, "/comms/achievements/" + uuid.NewString() + "/unpublish"},
}

var commsCounselorRoutes = []struct{ method, path string }{
	{http.MethodGet, "/comms/counselor/threads"},
	{http.MethodPost, "/comms/counselor/threads"},
	{http.MethodGet, "/comms/counselor/threads/" + uuid.NewString()},
	{http.MethodGet, "/comms/counselor/threads/" + uuid.NewString() + "/messages"},
	{http.MethodPost, "/comms/counselor/threads/" + uuid.NewString() + "/messages"},
	{http.MethodGet, "/comms/counselor/threads/" + uuid.NewString() + "/participants"},
	{http.MethodPost, "/comms/counselor/threads/" + uuid.NewString() + "/participants"},
	{http.MethodPost, "/comms/counselor/threads/" + uuid.NewString() +
		"/participants/" + uuid.NewString() + "/remove"},
	{http.MethodPost, "/comms/counselor/threads/" + uuid.NewString() + "/close"},
	{http.MethodGet, "/comms/counselor/contacts"},
}

var commsPortalRoutes = []struct{ method, path string }{
	{http.MethodGet, "/portal/comms/grievances/" + uuid.NewString()},
	{http.MethodPost, "/portal/comms/grievances/" + uuid.NewString() + "/satisfaction"},
	{http.MethodGet, "/portal/comms/achievements"},
}

func allCommsRoutes() []struct{ method, path string } {
	var out []struct{ method, path string }
	for _, g := range [][]struct{ method, path string }{
		commsGrievanceReads, commsGrievanceWrites, commsShowcaseReads,
		commsShowcaseWrites, commsPublishRoutes, commsCounselorRoutes,
		commsPortalRoutes,
	} {
		out = append(out, g...)
	}
	return out
}

// A signed-in user holding nothing at all reaches nothing at all.
func TestCommsRefuseACallerWithNoPermissions(t *testing.T) {
	h := mountedComms(identityWith())
	for _, tc := range allCommsRoutes() {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
The grievance queue is the front desk's, and reading it is not working it.

	A receptionist who may see the visitor register may see the complaints
	queue; assigning an owner, escalating a case and writing the school's
	answer are the write rung.
*/
func TestCommsGrievanceReadRungReachesReadsOnly(t *testing.T) {
	h := mountedComms(identityWith(rbac.FrontDeskRead))
	for _, tc := range commsGrievanceReads {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with front_desk.read: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
	for _, tc := range commsGrievanceWrites {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only front_desk.read: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

/*
Recording a prize is not publishing it.

	Putting a named child and their photograph in front of every family in the
	school is the same act as sending a circular, so it takes the same rung.
	Somebody who maintains student records all day does not get to make that
	decision as a side effect.
*/
func TestCommsPublishingNeedsTheAnnouncementsRung(t *testing.T) {
	h := mountedComms(identityWith(rbac.StudentsRead, rbac.StudentsWrite))
	for _, tc := range commsShowcaseWrites {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with students.write: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
	for _, tc := range commsPublishRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with students.write but not announcements.write: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

// And the reverse: a communications officer who may publish a circular has no
// business editing a child's record to invent something to publish.
func TestCommsAnnouncementsRungCannotWriteRecords(t *testing.T) {
	h := mountedComms(identityWith(rbac.AnnouncementsWrite))
	for _, tc := range commsShowcaseWrites {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only announcements.write: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

/*
The grievance hub is not reachable from the welfare or teaching rungs.

	A head of department holding counselling and teaching permissions is
	exactly the person a complaint is most likely to be about, and the
	subject-exclusion predicate only protects a queue they can already open.
	They should not be able to open it at all on these grants.
*/
func TestCommsGrievanceQueueNotReachableFromWelfareGrants(t *testing.T) {
	h := mountedComms(identityWith(
		rbac.CounselingRead, rbac.HealthRead, rbac.DisciplineWrite,
		rbac.TimetableRead, rbac.StudentsReadAll))
	for _, tc := range append(append([]struct{ method, path string }{},
		commsGrievanceReads...), commsGrievanceWrites...) {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with welfare/teaching grants only: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

/*
Counselling threads are gated by participation, not by permission.

	welfare.counseling.read is what makes somebody eligible to be ASKED for a
	thread -- it is read in exactly one place, listCounselorContacts. It must
	not be, and is not, what opens the route: the route takes self.profile.read
	like any other signed-in screen, and the handler then requires a live row
	in counselor_thread_participants.

	So the assertion here is deliberately narrow and its limit is worth stating:
	the router lets any signed-in account through, and the confidentiality is
	entirely in threadRole. What this proves is that a caller holding
	welfare.counseling.read and no self.profile.read gets no privileged door of
	their own -- there is no counselling-permission route into these threads to
	be widened later.
*/
func TestCommsCounsellingIsNotOpenedByTheCounsellingPermission(t *testing.T) {
	h := mountedComms(identityWith(rbac.CounselingRead))
	for _, tc := range commsCounselorRoutes {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with welfare.counseling.read alone: got %d, want 403 "+
				"— the counselling permission must not be a door into a thread",
				tc.method, tc.path, got)
		}
	}
}

// Every signed-in account holds self.profile.read, so the counselling and
// portal routes reach their handlers and the participation check inside.
func TestCommsCounsellingReachesTheParticipationCheck(t *testing.T) {
	h := mountedComms(identityWith(rbac.SelfProfileRead))
	for _, tc := range append(append([]struct{ method, path string }{},
		commsCounselorRoutes...), commsPortalRoutes...) {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with self.profile.read: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
}

/*
A family's own grievance and the school's queue are different screens.

	A parent holds self.profile.read and nothing else. They must reach their
	own case through /portal/comms and must not reach the office's queue,
	which is where every other family's complaint is.
*/
func TestCommsParentCannotOpenTheOfficeQueue(t *testing.T) {
	h := mountedComms(identityWith(rbac.SelfProfileRead, rbac.SelfChildrenRead))
	for _, tc := range append(append([]struct{ method, path string }{},
		commsGrievanceReads...), commsGrievanceWrites...) {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s as a parent: got %d, want 403", tc.method, tc.path, got)
		}
	}
	for _, tc := range commsShowcaseWrites {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s as a parent: got %d, want 403", tc.method, tc.path, got)
		}
	}
}
