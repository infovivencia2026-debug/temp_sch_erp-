package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Every read route, called as every role, asserting no 500.

   THE FAULT THIS EXISTS FOR

   Go type-checks SQL as a string. A query naming a column that does not exist
   compiles, ships, deploys, and fails the first time somebody opens the screen
   — as a 500 with a stack trace in a server log, which is the worst place for
   a school to find it.

   That has now happened four times in a month, always the same shape:

     exam_subjects.subject_id, which does not exist — exam_subjects names a
     CLASS subject, so the subject is one join further;

     files.filename, where the column is original_name;

     a submitted_at timestamptz scanned into a *string, which only failed for
     the teachers who had actually submitted a paper;

     an INSERT whose column list and VALUES gained an argument its args did
     not, which only failed on the first real use.

   Every one was found by a person clicking, or by calling the endpoint by
   hand against production. None was found by a test, and none could have been
   found by reading the code, because the code is correct Go.

   WHAT THIS DOES

   Walks the real router, takes every GET, fills the path parameters with real
   ids from the database, and calls it as each role in turn. It asserts one
   thing and one thing only: the handler did not return 5xx.

   400 and 403 and 404 are all fine and all expected — a teacher refused the
   payroll is the product working. The only thing being tested is that the
   query ran.

   WHY GET ONLY. A sweep that POSTs would be a sweep that writes, and a test
   that writes to whatever database it is pointed at is a test somebody
   eventually runs against production. Reads carry the great majority of the
   SQL and all four of the faults above.

   Skipped without ERP_TEST_DATABASE_URL, because it needs a real schema —
   that is the whole point of it. The migration lint next door needs nothing
   and always runs.
*/

// The ids a path parameter can be filled with, learned from the database once.
type sweepWorld struct {
	student, section, class, employee, invoice, exam uuid.UUID
	institution                                      uuid.UUID
}

var pathParam = regexp.MustCompile(`\{[^}]+\}`)

/*
Which id to put in which slot.

	A random uuid in every position would give a sweep of 404s that never
	reached a query — the endpoint would answer "no such child" and the SQL
	this test exists to run would never run. Real ids make the handler do its
	work.
*/
func (w sweepWorld) fill(pattern string) string {
	out := pattern
	for _, m := range pathParam.FindAllString(pattern, -1) {
		name := strings.Trim(m, "{}")
		var v string
		switch {
		case strings.Contains(name, "section"):
			v = w.section.String()
		case strings.Contains(name, "class"):
			v = w.class.String()
		case strings.Contains(name, "employee"), strings.Contains(name, "staff"):
			v = w.employee.String()
		case strings.Contains(name, "invoice"):
			v = w.invoice.String()
		case strings.Contains(name, "exam"):
			v = w.exam.String()
		case name == "id", strings.Contains(name, "student"), strings.Contains(name, "child"):
			v = w.student.String()
		default:
			// Anything unrecognised gets a well-formed uuid rather than a word:
			// a handler that parses its parameter should reach its query, not
			// bail at "invalid id" and report a pass it did not earn.
			v = uuid.NewString()
		}
		out = strings.Replace(out, m, v, 1)
	}
	return out
}

func loadSweepWorld(t *testing.T, db *database.DB) sweepWorld {
	t.Helper()
	var w sweepWorld
	/* Read as the platform, because the sweep needs an institution to belong
	   to before it has one — AsPlatform is the same door the migrate command
	   uses and the only one that can see across tenants. */
	err := db.AsPlatform(t.Context(), func(tx pgx.Tx) error {
		if err := tx.QueryRow(t.Context(),
			`SELECT id FROM institutions ORDER BY created_at LIMIT 1`).
			Scan(&w.institution); err != nil {
			return err
		}
		inst := w.institution.String()
		for _, q := range []struct {
			sql  string
			into *uuid.UUID
		}{
			{`SELECT id FROM students  WHERE institution_id = '` + inst + `' LIMIT 1`, &w.student},
			{`SELECT id FROM sections  WHERE institution_id = '` + inst + `' LIMIT 1`, &w.section},
			{`SELECT id FROM classes   WHERE institution_id = '` + inst + `' LIMIT 1`, &w.class},
			{`SELECT id FROM employees WHERE institution_id = '` + inst + `' LIMIT 1`, &w.employee},
			{`SELECT id FROM invoices  WHERE institution_id = '` + inst + `' LIMIT 1`, &w.invoice},
			{`SELECT id FROM exams     WHERE institution_id = '` + inst + `' LIMIT 1`, &w.exam},
			// A missing one is fine: the slot gets a random uuid and the route
			// answers 404 having run its query, which is what is being tested.
		} {
			_ = tx.QueryRow(t.Context(), q.sql).Scan(q.into)
		}
		return nil
	})
	if err != nil || w.institution == uuid.Nil {
		t.Skipf("no institution in the test database; nothing to sweep (%v)", err)
	}
	return w
}

func TestEveryReadRouteAnswersWithoutFailing(t *testing.T) {
	if os.Getenv("ERP_TEST_DATABASE_URL") == "" {
		t.Skip("ERP_TEST_DATABASE_URL not set; skipping the route sweep")
	}
	db := testDB(t)
	world := loadSweepWorld(t, db)

	s := &Server{DB: db}
	router := s.Routes()

	// Every GET the router actually serves, taken from the router rather than
	// from a list — a list is a thing that goes stale the day a route is added.
	type route struct{ method, pattern string }
	var routes []route
	err := chi.Walk(router.(chi.Routes),
		func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if method == http.MethodGet {
				routes = append(routes, route{method, pattern})
			}
			return nil
		})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(routes) < 50 {
		t.Fatalf("only %d GET routes found; the walk is not seeing the real router", len(routes))
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].pattern < routes[j].pattern })

	// One identity per role, holding exactly that role's permissions — the
	// same bundle production seeds, so a route this sweep reaches is a route
	// the role really reaches.
	type actor struct {
		role string
		id   *httpx.Identity
	}
	var actors []actor
	for _, r := range rbac.SystemRoles {
		switch r.Key {
		case "seller_admin", "support_admin":
			// Platform roles have no institution of their own, and sweeping
			// them would test the tenant guard rather than the queries.
			continue
		}
		perms := map[string]struct{}{}
		for _, p := range r.Permissions {
			perms[p] = struct{}{}
		}
		actors = append(actors, actor{r.Key, &httpx.Identity{
			UserID:        uuid.New(),
			InstitutionID: world.institution,
			Permissions:   perms,
		}})
	}

	var failures []string
	for _, a := range actors {
		for _, rt := range routes {
			path := world.fill(rt.pattern)
			req := httptest.NewRequest(rt.method, path, nil)
			req = req.WithContext(httpx.WithIdentity(req.Context(), a.id))
			rec := httptest.NewRecorder()

			/* Routes whose dependency the harness does not build.

			   The job queue is a background worker with its own connection and
			   its own lifecycle; a Server built for a read sweep has none, so
			   /jobs panics on a nil pointer for a reason that is about this
			   test rather than about the product. Named explicitly and kept
			   short, because a skip list is where real failures go to hide. */
			if strings.HasPrefix(rt.pattern, "/jobs") {
				continue
			}

			func() {
				/* A panic is a failure of this route and not of the sweep. One
				   handler falling over must not take the other four hundred
				   with it, or the first fault found is the only fault
				   reported. */
				defer func() {
					if p := recover(); p != nil {
						failures = append(failures,
							fmt.Sprintf("PANIC %s as %s: %v", rt.pattern, a.role, p))
					}
				}()
				router.ServeHTTP(rec, req)
			}()

			if rec.Code >= 500 {
				body := strings.TrimSpace(rec.Body.String())
				if len(body) > 300 {
					body = body[:300] + "…"
				}
				failures = append(failures,
					fmt.Sprintf("%d %s as %s\n      %s", rec.Code, rt.pattern, a.role, body))
			}
		}
	}

	if len(failures) > 0 {
		sort.Strings(failures)
		t.Errorf("%d read routes failed.\n\n"+
			"A 5xx here is almost always SQL: a column that does not exist, a "+
			"type a Scan cannot take, an argument count that does not match. Go "+
			"compiles all three, so this test is the only thing between them and "+
			"a school.\n\n%s",
			len(failures), strings.Join(failures, "\n  "))
	}
}
