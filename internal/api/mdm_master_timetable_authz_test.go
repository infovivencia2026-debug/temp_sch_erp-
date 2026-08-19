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
Authorization for the mid-day meal register and the master timetable, decided
on the router production builds rather than on a restatement of it.

	No database is needed: RequirePermission runs before the handler, so a
	refusal never reaches one. identityWith and statusOf already exist in this
	package (fee_engine_authz_test.go) and are reused rather than redeclared.

	Both features reuse permissions that already existed. The property worth
	asserting is therefore not that some permission is checked, but that the
	read rung is genuinely a read rung: somebody who may look at the register
	must not be able to close a day, and somebody who may look at a draft must
	not be able to move a period in it. That distinction is the only thing
	standing between "the office can see the timetable" and "anybody who can
	see the timetable can rewrite it".
*/

func mountedMDM(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountMDM(r)
	return r
}

func mountedMasterTimetable(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountMasterTimetable(r)
	return r
}

var mdmRegisterReads = []struct{ method, path string }{
	{http.MethodGet, "/mdm-register/days"},
	{http.MethodGet, "/mdm-register/days/" + uuid.NewString()},
	{http.MethodGet, "/mdm-register/context"},
}

var mdmRegisterWrites = []struct{ method, path string }{
	{http.MethodPost, "/mdm-register/days"},
	{http.MethodPost, "/mdm-register/days/" + uuid.NewString() + "/close"},
	{http.MethodPost, "/mdm-register/days/" + uuid.NewString() + "/reopen"},
}

var masterTimetableReads = []struct{ method, path string }{
	{http.MethodGet, "/master-timetable/overview"},
	{http.MethodGet, "/master-timetable/drafts/" + uuid.NewString() + "/publish-preview"},
}

var masterTimetableWrites = []struct{ method, path string }{
	{http.MethodPost, "/master-timetable/drafts/" + uuid.NewString() + "/entries"},
	{http.MethodPut, "/master-timetable/drafts/" + uuid.NewString() + "/entries/" + uuid.NewString()},
	{http.MethodDelete, "/master-timetable/drafts/" + uuid.NewString() + "/entries/" + uuid.NewString()},
}

// A signed-in user holding nothing at all reaches nothing at all.
func TestMDMRegisterRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedMDM(identityWith())
	for _, tc := range append(append([]struct{ method, path string }{},
		mdmRegisterReads...), mdmRegisterWrites...) {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Reading the register is not filing it.

	admin.reports.read is what the monthly utilisation return already requires
	to be looked at, and it opens the register the same way. Recording a day,
	closing it and reopening a closed one are institution.write — the rung the
	existing /admin-ops/mdm writes sit on. Nothing new was invented, and a
	holder of the read rung must not be able to close a day: a closed day is
	the figure the school has filed.
*/
func TestMDMRegisterReadRungCannotWrite(t *testing.T) {
	h := mountedMDM(identityWith(rbac.ReportsRead))
	for _, tc := range mdmRegisterReads {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with admin.reports.read: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
	for _, tc := range mdmRegisterWrites {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only admin.reports.read: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

func TestMDMRegisterWriteRungReachesTheWrites(t *testing.T) {
	h := mountedMDM(identityWith(rbac.ReportsRead, rbac.InstitutionWrite))
	for _, tc := range mdmRegisterWrites {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with institution.write: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
}

func TestMasterTimetableRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedMasterTimetable(identityWith())
	for _, tc := range append(append([]struct{ method, path string }{},
		masterTimetableReads...), masterTimetableWrites...) {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s without any permission: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

/*
Looking at a draft is not editing one.

	A head of department holds academics.timetable.read so they can read a
	draft somebody else generated — the same reasoning timetable_ops.go states
	for the optimizer screen. Moving a period in it is academics.timetable.write,
	because a hand-edited draft is what gets published over the live grid.
*/
func TestMasterTimetableReadRungCannotEdit(t *testing.T) {
	h := mountedMasterTimetable(identityWith(rbac.TimetableRead))
	for _, tc := range masterTimetableReads {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with academics.timetable.read: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
	for _, tc := range masterTimetableWrites {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s with only academics.timetable.read: got %d, want 403",
				tc.method, tc.path, got)
		}
	}
}

func TestMasterTimetableWriteRungReachesTheEdits(t *testing.T) {
	h := mountedMasterTimetable(identityWith(rbac.TimetableRead, rbac.TimetableWrite))
	for _, tc := range masterTimetableWrites {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s with academics.timetable.write: got 403, want the handler reached",
				tc.method, tc.path)
		}
	}
}
