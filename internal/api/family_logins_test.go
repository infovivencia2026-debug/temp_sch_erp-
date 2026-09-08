package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* The family's way in, checked at the three places it is issued.

   Guarded on ERP_TEST_DATABASE_URL like every other database-backed test in
   this package. What is pinned here is what a school actually hits:

     1. A father and a mother on one handset. The users table is unique on
        (institution, phone), so the second of them used to be reported as
        "already belongs to another account" -- a fact about the household
        presented as a fault in the data. Both must end up able to sign in.
     2. A credential that is issued is also sent. The admission desk did
        this; the profile button and the bulk run did not.
     3. A circular ticked "email" reaches a family with an address and no
        login, and the reported reach counts them.
*/

// familyWorld is one school with one child and whichever guardians the test
// adds. The office user exists because announcements.created_by is a foreign
// key to users, and a made-up identity would fail the insert.
type familyWorld struct {
	*admissionsWorld
	student uuid.UUID
	office  uuid.UUID
}

func seedFamilyWorld(t *testing.T, db *database.DB, name string) *familyWorld {
	t.Helper()
	ctx := context.Background()
	w := &familyWorld{admissionsWorld: seedAdmissionsWorld(t, db, name),
		student: uuid.New(), office: uuid.New()}
	err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (id, institution_id, username, full_name, password_hash, status)
			VALUES ($1,$2,'office'::citext,'The Office','x','active')`, w.office, w.inst); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO students (id, institution_id, campus_id, admission_no, first_name, status)
			VALUES ($1,$2,$3,'ADM-1','Aarav','active')`, w.student, w.inst, w.campus)
		return err
	})
	if err != nil {
		t.Fatalf("seed family: %v", err)
	}
	return w
}

func (w *familyWorld) guardian(t *testing.T, name, relation, phone, email string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	ctx := context.Background()
	err := w.db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO guardians (id, institution_id, full_name, relation, phone, email)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,'')::citext)`,
			id, w.inst, name, relation, phone, email); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO student_guardians (student_id, guardian_id, institution_id, is_primary)
			VALUES ($1,$2,$3,$4)`, w.student, id, w.inst, relation == "father")
		return err
	})
	if err != nil {
		t.Fatalf("seed guardian %s: %v", name, err)
	}
	return id
}

func (w *familyWorld) officeIdentity() *httpx.Identity {
	return &httpx.Identity{
		UserID: w.office, InstitutionID: w.inst,
		Permissions: map[string]struct{}{rbac.StudentsWrite: {}, rbac.AnnouncementsWrite: {}},
	}
}

func (w *familyWorld) userOf(t *testing.T, guardianID uuid.UUID) *uuid.UUID {
	t.Helper()
	var uid *uuid.UUID
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			return tx.QueryRow(context.Background(),
				`SELECT user_id FROM guardians WHERE id = $1`, guardianID).Scan(&uid)
		})
	if err != nil {
		t.Fatalf("read guardian: %v", err)
	}
	return uid
}

func (w *familyWorld) call(t *testing.T, h http.HandlerFunc, method, path, body string,
	params map[string]string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := httpx.WithIdentity(req.Context(), w.officeIdentity())
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code/100 != 2 {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	return out
}

func TestBulkGuardianLoginsShareOneHandset(t *testing.T) {
	db := testDB(t)
	w := seedFamilyWorld(t, db, "One Handset School")
	w.configureEmail(t)
	father := w.guardian(t, "Ramesh Kumar", "father", "9000000011", "ramesh@example.test")
	// Both with an address, because the run visits guardians in no particular
	// order and whichever is first is the one whose credential goes out.
	mother := w.guardian(t, "Sunita Kumar", "mother", "9000000011", "sunita@example.test")

	out := w.call(t, w.s.issueLoginsInBulk, http.MethodPost, "/setup/logins/bulk",
		`{"kind":"guardians"}`, nil)

	if out["created"].(float64) != 1 || out["existing"].(float64) != 1 || out["skipped"].(float64) != 0 {
		t.Fatalf("created=%v existing=%v skipped=%v, want 1, 1, 0 (%v)",
			out["created"], out["existing"], out["skipped"], out)
	}
	fu, mu := w.userOf(t, father), w.userOf(t, mother)
	if fu == nil || mu == nil {
		t.Fatalf("a guardian was left without a login: father=%v mother=%v", fu, mu)
	}
	if *fu != *mu {
		t.Errorf("one handset produced two accounts (%s, %s); the household should share one", fu, mu)
	}

	// The one new password also went to the family.
	if out["sent"].(float64) != 1 {
		t.Errorf("sent = %v, want 1", out["sent"])
	}
	rows := w.logRows(t)
	if len(rows) != 1 || rows[0].Template != "admissions.portal_login" ||
		(rows[0].Recipient != "ramesh@example.test" && rows[0].Recipient != "sunita@example.test") {
		t.Errorf("message_log = %+v, want one admissions.portal_login to the household", rows)
	}

	// Run again: nothing is minted, nothing is re-sent, nobody is skipped.
	again := w.call(t, w.s.issueLoginsInBulk, http.MethodPost, "/setup/logins/bulk",
		`{"kind":"guardians"}`, nil)
	if again["created"].(float64) != 0 || again["existing"].(float64) != 2 {
		t.Errorf("second run: created=%v existing=%v, want 0 and 2", again["created"], again["existing"])
	}
	if got := len(w.logRows(t)); got != 1 {
		t.Errorf("second run queued %d more messages; a login nobody re-issued must not be re-sent", got-1)
	}
}

func TestIssueGuardianLoginIsSentAndNotResentUntilReset(t *testing.T) {
	db := testDB(t)
	w := seedFamilyWorld(t, db, "Profile Button School")
	w.configureEmail(t)
	g := w.guardian(t, "Lakshmi Rao", "mother", "9000000012", "lakshmi@example.test")
	params := map[string]string{"id": g.String()}

	out := w.call(t, w.s.issueGuardianLogin, http.MethodPost, "/setup/guardians/x/login", "", params)
	if out["password"] == "" {
		t.Fatalf("no password issued: %v", out)
	}
	sent, _ := out["sent_to"].([]any)
	if len(sent) != 1 || sent[0] != "email" {
		t.Errorf("sent_to = %v, want [email]", out["sent_to"])
	}
	if rows := w.logRows(t); len(rows) != 1 || rows[0].Template != "admissions.portal_login" {
		t.Fatalf("message_log = %+v, want one admissions.portal_login", rows)
	}

	// Pressing the button again names the account and sends nothing.
	named := w.call(t, w.s.issueGuardianLogin, http.MethodPost, "/setup/guardians/x/login", "", params)
	if named["existing"] != true || named["password"] != "" {
		t.Errorf("second press: %v, want existing and no password", named)
	}
	if got := len(w.logRows(t)); got != 1 {
		t.Errorf("second press queued a message about a password that did not change (%d rows)", got)
	}

	// A reset is a new credential, and goes out.
	reset := w.call(t, w.s.issueGuardianLogin, http.MethodPost, "/setup/guardians/x/login?reset=true", "", params)
	if reset["password"] == "" {
		t.Fatalf("reset issued nothing: %v", reset)
	}
	if got := len(w.logRows(t)); got != 2 {
		t.Errorf("reset was not sent: %d rows in message_log, want 2", got)
	}
}

func TestCircularReachesAFamilyWithoutALogin(t *testing.T) {
	db := testDB(t)
	w := seedFamilyWorld(t, db, "Circular School")
	w.configureEmail(t)
	w.guardian(t, "Ramesh Kumar", "father", "9000000013", "ramesh.k@example.test")

	out := w.call(t, w.s.publishCircular, http.MethodPost, "/communication/circulars",
		`{"title":"Holiday on Monday","body":"The school is closed.","audience_role":"parents","send_email":true}`,
		nil)

	if out["recipients"].(float64) != 1 || out["without_login"].(float64) != 1 {
		t.Errorf("recipients=%v without_login=%v, want 1 and 1", out["recipients"], out["without_login"])
	}
	if out["unreachable_children"].(float64) != 0 {
		t.Errorf("unreachable_children=%v: a child whose father has an address is reachable", out["unreachable_children"])
	}
	if out["email_queued"].(float64) != 1 {
		t.Errorf("email_queued=%v, want 1", out["email_queued"])
	}
	rows := w.logRows(t)
	if len(rows) != 1 || rows[0].Template != "announcement.published" ||
		rows[0].Recipient != "ramesh.k@example.test" {
		t.Errorf("message_log = %+v, want the circular queued to the father's address", rows)
	}
}
