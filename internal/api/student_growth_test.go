package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The streak, the badges and the hall of fame, asserted on the router production
builds and on the two counts the screens are built from.

	identityWith and statusOf live in fee_engine_authz_test.go.
*/

func mountedStudentGrowth(id *httpx.Identity) http.Handler {
	s := &Server{}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	s.mountStudentGrowth(r)
	return r
}

func day(s string) time.Time {
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return d
}

// The three keys the routes gate on must be catalogue keys, or nobody is ever
// granted them and every screen answers 403 forever.
func TestStudentGrowthKeysAreCatalogued(t *testing.T) {
	for _, k := range []string{featStreak, featBadges, featHallOfFame} {
		if _, ok := catalog.Lookup(k); !ok {
			t.Errorf("%s is not in the catalogue", k)
		}
	}
}

// A child holding only the portal's permission cannot see the streak, the
// badges or the board until the school switches the feature on for their role.
func TestStudentGrowthRefusesWithoutTheFeatureKey(t *testing.T) {
	h := mountedStudentGrowth(identityWith(rbac.SelfProfileRead))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/learning/streak"},
		{http.MethodGet, "/learning/badges"},
		{http.MethodGet, "/campus/hall-of-fame"},
		{http.MethodPost, "/campus/hall-of-fame"},
		{http.MethodPost, "/campus/hall-of-fame/" + uuid.NewString() + "/retire"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403", tc.method, tc.path, got)
		}
	}
}

// Holding the feature key gets past the door (the handler then reaches a nil DB
// and panics, which statusOf reports as 500 — the guard is what is under test).
func TestStudentGrowthAdmitsTheFeatureKeys(t *testing.T) {
	h := mountedStudentGrowth(identityWith(rbac.SelfProfileRead, featStreak, featBadges, featHallOfFame))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/learning/streak"},
		{http.MethodGet, "/learning/badges"},
		{http.MethodGet, "/campus/hall-of-fame"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s: 403 for the key this route is for", tc.method, tc.path)
		}
	}
	// The feature key reads the board; it does not write it.
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/campus/hall-of-fame"},
		{http.MethodPost, "/campus/hall-of-fame/" + uuid.NewString() + "/retire"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403 — a child cannot write the foyer board", tc.method, tc.path, got)
		}
	}
}

// Whoever publishes announcements keeps the board, and reads it too.
func TestStudentGrowthHallOfFameIsKeptByAnnouncers(t *testing.T) {
	h := mountedStudentGrowth(identityWith(rbac.SelfProfileRead, rbac.AnnouncementsWrite))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/campus/hall-of-fame"},
		{http.MethodPost, "/campus/hall-of-fame"},
		{http.MethodPost, "/campus/hall-of-fame/" + uuid.NewString() + "/retire"},
	} {
		if got := statusOf(t, h, tc.method, tc.path); got == http.StatusForbidden {
			t.Errorf("%s %s: 403 for comms.announcements.write", tc.method, tc.path)
		}
	}
}

func TestStreakOf(t *testing.T) {
	today := day("2026-09-03")
	cases := []struct {
		name             string
		days             []string
		current, longest int
	}{
		{"nothing", nil, 0, 0},
		{"today only", []string{"2026-09-03"}, 1, 1},
		{"three ending today", []string{"2026-09-01", "2026-09-02", "2026-09-03"}, 3, 3},
		{"not yet opened today keeps yesterday's run", []string{"2026-08-31", "2026-09-01", "2026-09-02"}, 3, 3},
		{"a gap of a day breaks it", []string{"2026-08-30", "2026-08-31", "2026-09-03"}, 1, 2},
		{"stale run is not current", []string{"2026-08-20", "2026-08-21", "2026-08-22"}, 0, 3},
		{"duplicates do not count twice", []string{"2026-09-03", "2026-09-03", "2026-09-02"}, 2, 2},
		{"longest is anywhere", []string{"2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-09-03"}, 1, 4},
	}
	for _, tc := range cases {
		var days []time.Time
		for _, d := range tc.days {
			days = append(days, day(d))
		}
		cur, lng := streakOf(days, today)
		if cur != tc.current || lng != tc.longest {
			t.Errorf("%s: got current=%d longest=%d, want %d/%d", tc.name, cur, lng, tc.current, tc.longest)
		}
	}
}

func TestOnTimeStreak(t *testing.T) {
	today := day("2026-09-03")
	on := func(s string) *time.Time { d := day(s); return &d }
	marks := []homeworkMark{
		{DueOn: day("2026-09-10")},                                // not yet due: skipped
		{DueOn: day("2026-09-02"), SubmittedOn: on("2026-09-02")}, // on time
		{DueOn: day("2026-09-01"), SubmittedOn: on("2026-08-31")}, // early
		{DueOn: day("2026-08-28"), SubmittedOn: on("2026-08-29")}, // late: ends the run
		{DueOn: day("2026-08-25"), SubmittedOn: on("2026-08-25")}, // on time, but behind the late one
		{DueOn: day("2026-08-20")},                                // never handed in
	}
	streak, onTime, due := onTimeStreak(marks, today)
	if streak != 2 || onTime != 3 || due != 5 {
		t.Errorf("got streak=%d onTime=%d due=%d, want 2/3/5", streak, onTime, due)
	}
	if s, o, d := onTimeStreak(nil, today); s != 0 || o != 0 || d != 0 {
		t.Errorf("empty: got %d/%d/%d", s, o, d)
	}
}

// A badge is earned by the longest run ever, so a broken streak keeps its week.
func TestStreakBadges(t *testing.T) {
	earned := map[string]bool{}
	for _, b := range streakBadges(9, 5) {
		earned[b.Key] = b.Earned
	}
	for k, want := range map[string]bool{
		"open_3": true, "open_7": true, "open_14": false,
		"homework_5": true, "homework_10": false,
	} {
		if earned[k] != want {
			t.Errorf("%s: earned=%v, want %v", k, earned[k], want)
		}
	}
}
