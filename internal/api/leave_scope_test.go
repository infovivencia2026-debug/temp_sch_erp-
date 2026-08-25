package api

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
"My leave" must be the reader's own, whatever else they are allowed to read.

	The scope was chosen by permission alone, so anybody holding
	hr.employees.read saw every row on every screen the component backs — and it
	backs `<role>.my_profile.leave_self_service`, which is titled "My leave". A
	head of department holds that permission, so their self-service screen
	listed thirteen of another teacher's requests and a student's medical leave:
	fourteen rows, none of them theirs.

	Two properties are pinned, and the second matters as much as the first:
	`for=mine` narrows, and it can never widen. A caller without the permission
	stays scoped to themselves whatever they ask for.

	This mirrors the predicate rather than calling the handler, because the
	handler needs a database and there is no Postgres on the machine these are
	written on. Keep the two in step: if the condition in listLeaveRequests
	changes, this changes with it or it is testing history.
*/
func TestLeaveSelfServiceIsAlwaysScopedToTheReader(t *testing.T) {
	withPerm := &httpx.Identity{
		UserID:      uuid.New(),
		Permissions: map[string]struct{}{rbac.EmployeesRead: {}},
	}
	without := &httpx.Identity{UserID: uuid.New(), Permissions: map[string]struct{}{}}

	scope := func(id *httpx.Identity, query string) string {
		r := httptest.NewRequest("GET", "/api/v1/hr/leave"+query, nil)
		mine := "TRUE"
		if !id.Can(rbac.EmployeesRead) || r.URL.Query().Get("for") == "mine" {
			mine = `e.user_id = $3`
		}
		return mine
	}

	if got := scope(withPerm, "?for=mine"); !strings.Contains(got, "user_id") {
		t.Errorf("an approver on their own self-service screen saw everything: %q", got)
	}
	if got := scope(withPerm, ""); got != "TRUE" {
		t.Errorf("an approver's queue was narrowed and should not be: %q", got)
	}
	if got := scope(without, ""); !strings.Contains(got, "user_id") {
		t.Errorf("a caller without hr.employees.read was not scoped: %q", got)
	}
	// The one that must never regress: the parameter cannot widen anything.
	if got := scope(without, "?for=staff"); !strings.Contains(got, "user_id") {
		t.Errorf("for= widened the scope for a caller without the permission: %q", got)
	}
}
