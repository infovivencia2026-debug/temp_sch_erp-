package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Acting on a school you have just suspended.

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

/* A board member switching between the schools they oversee.

   A board member is NOT a platform admin. The switch is the same middleware,
   but gated on membership — a user_roles row in the target school — and it
   never confers platform powers: id.PlatformAdmin stays false, so the acted
   school's data still reads under RLS with the caller's own grants.

   These three cases are the whole security contract of the board path:
     - a member is let in and the tenant is amended in place;
     - a non-member is refused, in words that do not reveal whether the school
       exists;
     - a suspended school is refused a board member, as its own people are. */

// mkOtherSchool creates a second institution the board member can be switched
// into, returning its id. Cleaned up with the test.
func mkOtherSchool(t *testing.T, sc *classroomSchool) uuid.UUID {
	t.Helper()
	var other uuid.UUID
	if err := sc.db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			INSERT INTO institutions (name, short_name, slug, status)
			VALUES ('Other Test','Other',$1,'active') RETURNING id`,
			"ot-"+uuid.NewString()[:8]).Scan(&other)
	}); err != nil {
		t.Fatalf("other institution: %v", err)
	}
	t.Cleanup(func() {
		_ = sc.db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, other)
			return err
		})
	})
	return other
}

// grantBoardMember installs board_member in a school and gives one user that
// membership, the way the seller endpoint does.
func grantBoardMember(t *testing.T, sc *classroomSchool, inst, user uuid.UUID) {
	t.Helper()
	if err := sc.db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
		roleID, _, err := rbac.InstallRole(context.Background(), tx, inst, "board_member")
		if err != nil {
			return err
		}
		_, err = tx.Exec(context.Background(), `
			INSERT INTO user_roles (institution_id, user_id, role_id)
			VALUES ($1,$2,$3)
			ON CONFLICT (user_id, role_id) WHERE campus_id IS NULL DO NOTHING`,
			inst, user, roleID)
		return err
	}); err != nil {
		t.Fatalf("grant board_member: %v", err)
	}
}

func TestBoardMemberActsOnASchoolTheyOversee(t *testing.T) {
	sc := newClassroomSchool(t)
	other := mkOtherSchool(t, sc)
	member := uuid.New()
	grantBoardMember(t, sc, other, member)

	var landed uuid.UUID
	h := ActingInstitution(sc.db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		landed = httpx.IdentityFrom(r.Context()).InstitutionID
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil)
	req.Header.Set(actingHeader, other.String())
	// Home is sc.inst; PlatformAdmin false — an ordinary school user.
	req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
		UserID: member, InstitutionID: sc.inst,
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("a member was refused a school they oversee: %d %s", w.Code, w.Body.String())
	}
	if landed != other {
		t.Fatalf("acted institution = %s, want the overseen school %s", landed, other)
	}
}

func TestNonMemberIsRefusedAndSchoolExistenceHidden(t *testing.T) {
	sc := newClassroomSchool(t)
	other := mkOtherSchool(t, sc)
	stranger := uuid.New() // no membership anywhere

	h := ActingInstitution(sc.db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a non-member reached a school they do not oversee")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil)
	req.Header.Set(actingHeader, other.String())
	req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
		UserID: stranger, InstitutionID: sc.inst,
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	if !strings.Contains(w.Body.String(), "do not oversee") {
		t.Errorf("refusal should not reveal existence: %s", w.Body.String())
	}
	// A school that does not exist must answer identically — no enumeration.
	gone := uuid.New()
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil)
	req2.Header.Set(actingHeader, gone.String())
	req2 = req2.WithContext(httpx.WithIdentity(req2.Context(), &httpx.Identity{
		UserID: stranger, InstitutionID: sc.inst,
	}))
	w2 := httptest.NewRecorder()
	ActingInstitution(sc.db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a non-existent school was accepted")
	})).ServeHTTP(w2, req2)
	if w2.Code != w.Code || w2.Body.String() != w.Body.String() {
		t.Errorf("non-member and non-existent differ (%d/%s vs %d/%s): enumeration leak",
			w.Code, w.Body.String(), w2.Code, w2.Body.String())
	}
}

func TestBoardMemberRefusedASuspendedSchool(t *testing.T) {
	sc := newClassroomSchool(t)
	other := mkOtherSchool(t, sc)
	member := uuid.New()
	grantBoardMember(t, sc, other, member)
	if err := sc.db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(),
			`UPDATE institutions SET status = 'suspended' WHERE id = $1`, other)
		return err
	}); err != nil {
		t.Fatalf("suspend: %v", err)
	}

	h := ActingInstitution(sc.db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a board member reached a suspended school")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/catalog", nil)
	req.Header.Set(actingHeader, other.String())
	req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
		UserID: member, InstitutionID: sc.inst,
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	if !strings.Contains(w.Body.String(), "suspended") {
		t.Errorf("refusal should say the school is suspended: %s", w.Body.String())
	}
}
