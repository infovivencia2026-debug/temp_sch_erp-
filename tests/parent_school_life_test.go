package tests

import (
	"fmt"
	"net/http"
	"testing"
)

/* The family school-life screens, driven as a real signed-in guardian.

   These are black box and end-to-end for the same reason the rest of this
   package is: the thing under test is not a Go function, it is the composition
   of session resolution, RBAC, the resolved scope and the SQL predicate in each
   handler. A unit test of any one of those would pass while the composition
   leaked, which is precisely the failure that matters here.

   The whole point of this domain is that one family cannot read another's, and
   that the refusal is a 404 rather than a 403 — a parent probing student ids
   must not be able to tell "exists but not yours" from "no such child",
   because the first confirms a roll number. Every endpoint is asserted against
   that, not just the ones that felt risky while writing them. */

// foreignStudent returns a student id the given guardian is not linked to,
// found through an account that may legitimately list everyone.
func foreignStudent(t *testing.T, base string, own map[string]bool) string {
	t.Helper()
	admin := login(t, base, "institution_admin@vivencia.test")
	var all struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	getJSON(t, admin, base+"/api/v1/students?limit=200", &all)
	for _, s := range all.Items {
		if !own[s.ID] {
			return s.ID
		}
	}
	return ""
}

// myChildren lists the ids the caller is actually entitled to.
func myChildren(t *testing.T, c *http.Client, base string) []string {
	t.Helper()
	var mine struct {
		Items []struct {
			StudentID string `json:"student_id"`
		} `json:"items"`
	}
	getJSON(t, c, base+"/api/v1/portal/students", &mine)
	out := make([]string, 0, len(mine.Items))
	for _, k := range mine.Items {
		out = append(out, k.StudentID)
	}
	return out
}

// The read endpoints, every one of which takes an attacker-controlled
// student_id in the query string.
var familyReadPaths = []string{
	"/api/v1/portal/school-life/calendar",
	"/api/v1/portal/school-life/ptm/slots",
	"/api/v1/portal/school-life/ptm/bookings",
	"/api/v1/portal/school-life/gallery",
	"/api/v1/portal/school-life/event-passes",
	"/api/v1/portal/academics/iep",
	"/api/v1/portal/profile/student-id-card",
	"/api/v1/portal/notifications",
	"/api/v1/portal/cafeteria/purchases",
}

// TestFamilyScreensRefuseAnotherFamilysChild is the security assertion this
// whole file exists for.
func TestFamilyScreensRefuseAnotherFamilysChild(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	kids := myChildren(t, parent, base)
	if len(kids) == 0 {
		t.Skip("the demo parent has no linked children")
	}
	own := map[string]bool{}
	for _, k := range kids {
		own[k] = true
	}
	foreign := foreignStudent(t, base, own)
	if foreign == "" {
		t.Skip("no unrelated student available in this dataset")
	}

	for _, p := range familyReadPaths {
		// Their own child must be readable, or the 404 below proves nothing:
		// an endpoint that refuses everybody would pass a negative-only test.
		if code := status(t, parent, fmt.Sprintf("%s?student_id=%s", base+p, kids[0])); code != 200 {
			t.Errorf("%s for their own child = %d, want 200", p, code)
		}
		if code := status(t, parent, fmt.Sprintf("%s?student_id=%s", base+p, foreign)); code != 404 {
			t.Errorf("%s for an unrelated child = %d, want 404", p, code)
		}
	}

	// A bare probe must still be useful. A screen renders before its child
	// picker has been touched, and a 400 there is a blank page.
	for _, p := range familyReadPaths {
		if code := status(t, parent, base+p); code != 200 {
			t.Errorf("%s probed bare = %d, want 200", p, code)
		}
	}
}

// TestFamilyWritesRefuseAnotherFamilysChild covers the two endpoints that
// create something against a child.
func TestFamilyWritesRefuseAnotherFamilysChild(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	kids := myChildren(t, parent, base)
	if len(kids) == 0 {
		t.Skip("the demo parent has no linked children")
	}
	own := map[string]bool{}
	for _, k := range kids {
		own[k] = true
	}
	foreign := foreignStudent(t, base, own)
	if foreign == "" {
		t.Skip("no unrelated student available in this dataset")
	}

	var slots struct {
		Items []struct {
			ID    string `json:"id"`
			Taken bool   `json:"taken"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/school-life/ptm/slots", &slots)

	var slot string
	for _, s := range slots.Items {
		if !s.Taken {
			slot = s.ID
			break
		}
	}
	if slot != "" {
		if code := send(t, parent, http.MethodPost,
			base+"/api/v1/portal/school-life/ptm/book",
			map[string]any{"slot_id": slot, "student_id": foreign}, nil); code != 404 {
			t.Errorf("booking a meeting for an unrelated child = %d, want 404", code)
		}
	}

	// An event id the caller has not been given is refused the same way, and a
	// student id they do not own is refused before the event is even looked up.
	if code := send(t, parent, http.MethodPost,
		base+"/api/v1/portal/school-life/event-passes",
		map[string]any{
			"event_id":   "00000000-0000-0000-0000-000000000000",
			"student_id": foreign,
		}, nil); code != 404 {
		t.Errorf("claiming a seat for an unrelated child = %d, want 404", code)
	}
}

// TestGateEndpointsAreStaffOnly. A parent recording their own arrival is the
// same mistake as a parent releasing their own child from the school gate.
func TestGateEndpointsAreStaffOnly(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	for _, p := range []string{
		"/api/v1/portal/school-life/event-passes/verify?code=12345678",
		"/api/v1/portal/profile/id-card/verify?code=PG-AAAAAAAA.BBBBBBBB",
	} {
		if code := status(t, parent, base+p); code != 403 {
			t.Errorf("parent reaching %s = %d, want 403", p, code)
		}
	}

	if code := send(t, parent, http.MethodPost,
		base+"/api/v1/portal/school-life/event-passes/00000000-0000-0000-0000-000000000000/admit",
		map[string]any{}, nil); code != 403 {
		t.Errorf("parent admitting their own pass = %d, want 403", code)
	}
}

/*
TestAlertDeliveryIsIdempotent guards the index that makes the feed possible.

	The delivery pass runs on every poll and inserts one row per fact. If the
	partial unique index behind it stopped matching — most easily by someone
	dropping the COALESCE around the nullable source_id, which would make every
	summary alert unique against every other — the feed would gain a duplicate
	of every circular on every refresh, and nothing else in the system would
	notice. A count that holds still across repeated polls is the cheapest
	assertion that catches it.
*/
func TestAlertDeliveryIsIdempotent(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	read := func() int {
		var feed struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		}
		getJSON(t, parent, base+"/api/v1/portal/notifications", &feed)
		return len(feed.Items)
	}

	first := read()
	for i := 0; i < 3; i++ {
		_ = read()
	}
	if again := read(); again != first {
		t.Errorf("alert feed grew from %d to %d across repeated polls — "+
			"delivery is inserting duplicates", first, again)
	}
	t.Logf("alert feed stable at %d rows across five polls", first)
}

/*
TestPTMBookingLandsInTheFrontDeskDiary is the reuse assertion.

	A booking made here has to be the same row the receptionist sees, or the
	school has two diaries and the second is the one nobody reads. The check is
	that the appointment the family created is visible through the front
	office's own endpoint, and that a second attempt on the same slot is
	refused rather than double-booking the teacher.
*/
func TestPTMBookingLandsInTheFrontDeskDiary(t *testing.T) {
	base := baseURL(t)
	parent := login(t, base, "parent@vivencia.test")

	kids := myChildren(t, parent, base)
	if len(kids) == 0 {
		t.Skip("the demo parent has no linked children")
	}

	var slots struct {
		Items []struct {
			ID    string `json:"id"`
			Taken bool   `json:"taken"`
		} `json:"items"`
	}
	getJSON(t, parent, base+"/api/v1/portal/school-life/ptm/slots", &slots)
	var slot string
	for _, s := range slots.Items {
		if !s.Taken {
			slot = s.ID
			break
		}
	}
	if slot == "" {
		t.Skip("no free PTM slot published in this dataset")
	}

	var booked struct {
		ID string `json:"id"`
	}
	if code := send(t, parent, http.MethodPost,
		base+"/api/v1/portal/school-life/ptm/book",
		map[string]any{"slot_id": slot, "student_id": kids[0],
			"note": "Integration test"}, &booked); code != 201 {
		t.Fatalf("booking a free slot = %d, want 201", code)
	}

	// The same slot cannot be taken twice, whoever asks. A 500 here would mean
	// the unique index fired but the handler let the transaction abort.
	if code := send(t, parent, http.MethodPost,
		base+"/api/v1/portal/school-life/ptm/book",
		map[string]any{"slot_id": slot, "student_id": kids[0]}, nil); code != 403 {
		t.Errorf("re-booking a taken slot = %d, want 403", code)
	}

	// The front desk sees it, because it is an appointment and not a copy.
	desk := login(t, base, "admissions@vivencia.test")
	var diary struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	// The office's own list, which defaults to the next thirty days.
	getJSON(t, desk, base+"/api/v1/office/appointments", &diary)
	found := false
	for _, a := range diary.Items {
		if a.ID == booked.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("the family's booking %s is not in the front desk diary — "+
			"the portal has grown a second diary", booked.ID)
	}

	// Tidy up so a re-run finds the slot free again.
	if code := send(t, parent, http.MethodPost,
		fmt.Sprintf("%s/api/v1/portal/school-life/ptm/%s/cancel", base, booked.ID),
		map[string]any{}, nil); code != 200 {
		t.Errorf("cancelling own booking = %d, want 200", code)
	}
}
