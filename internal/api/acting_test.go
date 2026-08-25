package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* Acting on a school you have just suspended.

   Suspending is a thing the vendor does TO a school, and the vendor then has to
   work inside it — to read what it owes, and above all to switch it back on.
   Requiring 'active' locked them out of the entire product instead: this
   middleware runs in front of /api/v1/catalog, so the menu came back 404 and
   there was no screen left to clear the stale selection from.

   A live incident, not a hypothetical: somebody suspended Gate Check School
   from the Access screen while acting as it, and every request afterwards
   answered "resource not found" with no menu.
*/
func TestActingOnASuspendedSchoolIsAllowed(t *testing.T) {
	sc := newClassroomSchool(t)
	suspended := sc.inst

	sc.tx(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(),
			`UPDATE institutions SET status = 'suspended' WHERE id = $1`, suspended)
		return err
	})

	reached := false
	h := ActingInstitution(sc.db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil)
	req.Header.Set(actingHeader, suspended.String())
	req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
		UserID: uuid.New(), PlatformAdmin: true,
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if !reached {
		t.Fatalf("a platform operator was refused their own menu while acting on a "+
			"suspended school: status %d, body %s", w.Code, w.Body.String())
	}
}

// An id naming nothing is still refused — and says so in words somebody can
// act on, rather than "resource not found" on every request including the menu.
func TestActingOnAMissingSchoolSaysWhichAndWhy(t *testing.T) {
	sc := newClassroomSchool(t)

	h := ActingInstitution(sc.db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a school that does not exist was accepted")
	}))

	gone := uuid.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil)
	req.Header.Set(actingHeader, gone.String())
	req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
		UserID: uuid.New(), PlatformAdmin: true,
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{gone.String(), "Pick a school again"} {
		if !strings.Contains(body, want) {
			t.Errorf("refusal does not mention %q: %s", want, body)
		}
	}
}
