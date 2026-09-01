package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
)

/*
THE ADMISSIONS MESSAGE, AND THE FOUR WAYS IT USED TO LIE.

	/admissions/message wrote "we told them on the ninth" into an application's
	remarks and sent nothing at all. The four tests here are the four claims
	that record now has to earn, and each of them is a way the file could go on
	lying if this code were changed carelessly:

	  1. A parent with no email address is not recorded as told.
	  2. A send that FAILS -- an unconfigured provider, most often -- is not
	     recorded as told either. This is the one that matters most: a failure
	     is invisible on the screen unless somebody makes it visible.
	  3. A send that succeeds IS recorded, and reaches message_log through the
	     one send contract rather than around it.
	  4. A parent who already has a login keeps the password they are holding.

	And the fifth, which is not about the record at all: one family cannot read
	another's admission, asserted rather than assumed from the query.

	Guarded on ERP_TEST_DATABASE_URL like every other database-backed test in
	this package, so `go test ./internal/...` stays green without Postgres.

	    ERP_TEST_DATABASE_URL=postgres://erp_owner:...@127.0.0.1:5432/erp_x \
	    CREDENTIAL_KEY=... go test ./internal/api/ -run Applicant -v
*/

// admissionsWorld is one school with one class and nothing else. Applications
// and guardians are added by the test that wants them, because a fixture
// shared between these tests would let one of them pass on another's rows.
type admissionsWorld struct {
	inst   uuid.UUID
	campus uuid.UUID
	class  uuid.UUID
	db     *database.DB
	s      *Server
}

func seedAdmissionsWorld(t *testing.T, db *database.DB, name string) *admissionsWorld {
	t.Helper()
	ctx := context.Background()
	w := &admissionsWorld{
		inst: uuid.New(), campus: uuid.New(), class: uuid.New(), db: db,
	}
	suffix := w.inst.String()[:8]
	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO institutions (id, name, short_name, slug, timezone, status)
			VALUES ($1, $2, 'ADM', $3, 'Asia/Kolkata', 'active')`,
			w.inst, name, "adm-"+suffix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO campuses (id, institution_id, name, code)
			VALUES ($1,$2,'Main',$3)`, w.campus, w.inst, "MAIN-"+suffix); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO classes (id, institution_id, campus_id, name, level)
			VALUES ($1,$2,$3,'Class 1',1)`, w.class, w.inst, w.campus); err != nil {
			return err
		}
		// The parent role, because issuing a login grants it and grantRole
		// fails loudly rather than inventing one.
		_, err := tx.Exec(ctx, `
			INSERT INTO roles (institution_id, key, name, is_system)
			VALUES ($1,'parent','Parent', true)
			ON CONFLICT DO NOTHING`, w.inst)
		return err
	})
	if err != nil {
		t.Fatalf("seed world: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, w.inst)
			return err
		})
	})
	w.s = &Server{
		DB:      db,
		Hasher:  auth.NewHasher("test-pepper"),
		BaseURL: "https://school.test",
	}
	return w
}

// configureEmail makes the SMTP provider report itself configured. No password
// is stored: openSecret returns "" for empty credentials, and nothing here
// dials anything -- queueing is a row, and sending is the dispatcher's job.
func (w *admissionsWorld) configureEmail(t *testing.T) {
	t.Helper()
	cfg, _ := json.Marshal(map[string]any{
		"host": "smtp.test", "port": 587, "from_address": "office@school.test",
	})
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `
				INSERT INTO integrations (institution_id, kind, provider, config, enabled)
				VALUES ($1,'messaging','email',$2,true)`, w.inst, cfg)
			return err
		})
	if err != nil {
		t.Fatalf("configure email: %v", err)
	}
}

// application inserts one, with or without an email address on it.
func (w *admissionsWorld) application(t *testing.T, child, email string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `
				INSERT INTO applications (id, institution_id, campus_id, application_no,
				                          first_name, last_name, class_sought,
				                          parent_name, parent_phone, parent_email, status)
				VALUES ($1,$2,$3,$4,$5,'Rao',$6,'Lakshmi Rao',$7,NULLIF($8,'')::citext,'submitted')`,
				id, w.inst, w.campus, "APP-"+id.String()[:8], child, w.class,
				"9"+id.String()[:9], email)
			return err
		})
	if err != nil {
		t.Fatalf("seed application: %v", err)
	}
	return id
}

func (w *admissionsWorld) identity() *httpx.Identity {
	return &httpx.Identity{UserID: uuid.New(), InstitutionID: w.inst}
}

// callMessage posts to the handler directly. The permission gate is asserted
// where it lives, in the router tests; what is under test here is what the
// handler does once it is through.
func (w *admissionsWorld) callMessage(t *testing.T, body string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/admissions/message",
		strings.NewReader(body))
	req = req.WithContext(httpx.WithIdentity(req.Context(), w.identity()))
	rec := httptest.NewRecorder()
	w.s.messageApplicants(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("messageApplicants: %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	return out
}

func (w *admissionsWorld) remarks(t *testing.T, appID uuid.UUID) string {
	t.Helper()
	var remarks *string
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			return tx.QueryRow(context.Background(),
				`SELECT remarks FROM applications WHERE id = $1`, appID).Scan(&remarks)
		})
	if err != nil {
		t.Fatalf("read remarks: %v", err)
	}
	if remarks == nil {
		return ""
	}
	return *remarks
}

func (w *admissionsWorld) logRows(t *testing.T) []struct {
	Template  string
	Status    string
	Recipient string
} {
	t.Helper()
	var out []struct {
		Template  string
		Status    string
		Recipient string
	}
	err := w.db.InTenant(context.Background(), database.Scope{InstitutionID: w.inst},
		func(tx pgx.Tx) error {
			rows, err := tx.Query(context.Background(), `
				SELECT template_code, status, recipient FROM message_log
				 WHERE institution_id = $1 ORDER BY queued_at`, w.inst)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var r struct {
					Template  string
					Status    string
					Recipient string
				}
				if err := rows.Scan(&r.Template, &r.Status, &r.Recipient); err != nil {
					return err
				}
				out = append(out, r)
			}
			return rows.Err()
		})
	if err != nil {
		t.Fatalf("read message_log: %v", err)
	}
	return out
}

/*
An applicant with no email address is reported, not recorded as told.

	parent_email is nullable and a form taken across the counter often has a
	phone number and nothing else. The old handler wrote the remark anyway.
*/
func TestApplicantMessageWithoutEmailIsNotRecordedAsSent(t *testing.T) {
	db := testDB(t)
	w := seedAdmissionsWorld(t, db, "No Email School")
	w.configureEmail(t)
	app := w.application(t, "Asha", "")

	out := w.callMessage(t, `{"ids":["`+app.String()+`"],"message":"Please bring the birth certificate"}`)

	if out["messaged"].(float64) != 0 {
		t.Errorf("messaged = %v, want 0 for an applicant with no address", out["messaged"])
	}
	if out["sent"].(float64) != 0 {
		t.Errorf("sent = %v, want 0", out["sent"])
	}
	notSent, _ := out["not_sent"].([]any)
	if len(notSent) != 1 {
		t.Fatalf("not_sent = %v, want the one applicant who has no address", out["not_sent"])
	}
	if reason := notSent[0].(map[string]any)["reason"].(string); !strings.Contains(reason, "email") {
		t.Errorf("reason = %q, want it to say there is no email address", reason)
	}
	if r := w.remarks(t, app); r != "" {
		t.Errorf("remarks = %q, want nothing: the family was never told", r)
	}
	if rows := w.logRows(t); len(rows) != 0 {
		t.Errorf("message_log has %d rows, want none", len(rows))
	}
}

/*
A send that FAILS is not recorded as a send.

	The provider is deliberately left unconfigured, which is the commonest
	failure in a real school: email was never set up, and every message queued
	against it would be a message nobody receives. QueueMessage refuses before
	writing a row -- and the remark must be refused with it.
*/
func TestApplicantMessageFailedSendIsNotRecordedAsSent(t *testing.T) {
	db := testDB(t)
	w := seedAdmissionsWorld(t, db, "No Provider School")
	// No configureEmail: the school has no email provider.
	app := w.application(t, "Bhavya", "bhavya.parent@example.test")

	out := w.callMessage(t, `{"ids":["`+app.String()+`"],"message":"Interview on Thursday"}`)

	if out["messaged"].(float64) != 0 {
		t.Errorf("messaged = %v, want 0: nothing was sent", out["messaged"])
	}
	notSent, _ := out["not_sent"].([]any)
	if len(notSent) != 1 {
		t.Fatalf("not_sent = %v, want the failed applicant", out["not_sent"])
	}
	if r := w.remarks(t, app); r != "" {
		t.Errorf("remarks = %q, want nothing: the send failed", r)
	}
	if rows := w.logRows(t); len(rows) != 0 {
		t.Errorf("message_log has %d rows, want none", len(rows))
	}
}

// The ordinary case, so that the two tests above are pinning a distinction and
// not simply a handler that never sends anything.
func TestApplicantMessageSendsAndRecords(t *testing.T) {
	db := testDB(t)
	w := seedAdmissionsWorld(t, db, "Working School")
	w.configureEmail(t)
	app := w.application(t, "Chandra", "chandra.parent@example.test")

	out := w.callMessage(t, `{"ids":["`+app.String()+`"],"message":"Documents received"}`)

	if out["sent"].(float64) != 1 || out["messaged"].(float64) != 1 {
		t.Fatalf("sent=%v messaged=%v, want 1 and 1 (%v)", out["sent"], out["messaged"], out)
	}
	if r := w.remarks(t, app); !strings.Contains(r, "Documents received") {
		t.Errorf("remarks = %q, want the message recorded", r)
	}
	rows := w.logRows(t)
	if len(rows) != 1 {
		t.Fatalf("message_log has %d rows, want 1", len(rows))
	}
	if rows[0].Template != "admissions.office_message" {
		t.Errorf("template = %q", rows[0].Template)
	}
	if rows[0].Recipient != "chandra.parent@example.test" {
		t.Errorf("recipient = %q", rows[0].Recipient)
	}
	if rows[0].Status != "queued" {
		t.Errorf("status = %q, want queued", rows[0].Status)
	}
}

/*
A parent who already has a login keeps the one they are holding.

	The sibling case, and the one that silently breaks a family: a second
	application must attach itself to the account the parent already signs in
	with rather than mint a second password that replaces it.
*/
func TestApplicantLoginNeverResetsAnExistingPassword(t *testing.T) {
	db := testDB(t)
	w := seedAdmissionsWorld(t, db, "Sibling School")
	w.configureEmail(t)
	ctx := context.Background()

	// A guardian who is already signing in about an older child.
	guardian, user := uuid.New(), uuid.New()
	before := "existing-hash"
	err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (id, institution_id, username, email, phone, full_name,
			                   password_hash, status)
			VALUES ($1,$2,'lakshmi'::citext,'lakshmi@example.test'::citext,'9000000001',
			        'Lakshmi Rao',$3,'active')`, user, w.inst, before); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO guardians (id, institution_id, full_name, relation, phone, email, user_id)
			VALUES ($1,$2,'Lakshmi Rao','mother','9000000001','lakshmi@example.test'::citext,$3)`,
			guardian, w.inst, user)
		return err
	})
	if err != nil {
		t.Fatalf("seed guardian: %v", err)
	}

	// The younger child's application, carrying the same contact details.
	app := uuid.New()
	err = db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO applications (id, institution_id, campus_id, application_no,
			                          first_name, class_sought, parent_name,
			                          parent_phone, parent_email, status)
			VALUES ($1,$2,$3,'APP-SIB','Deepa',$4,'Lakshmi Rao','9000000001',
			        'lakshmi@example.test'::citext,'submitted')`,
			app, w.inst, w.campus, w.class)
		return err
	})
	if err != nil {
		t.Fatalf("seed application: %v", err)
	}

	var welcome applicantWelcome
	err = db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		welcome = w.s.ensureApplicantLogin(ctx, tx, w.inst, app)
		return nil
	})
	if err != nil {
		t.Fatalf("ensureApplicantLogin: %v", err)
	}

	if !welcome.Existing {
		t.Errorf("existing = false, want true: this parent already had a login")
	}
	if welcome.Password != "" {
		t.Errorf("a password was issued to a parent who already had one")
	}

	var (
		after      string
		guardianOn *uuid.UUID
		users      int
	)
	err = db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT password_hash FROM users WHERE id = $1`, user).Scan(&after); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`SELECT guardian_id FROM applications WHERE id = $1`, app).Scan(&guardianOn); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM users WHERE institution_id = $1`, w.inst).Scan(&users)
	})
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if after != before {
		t.Errorf("the parent's password was replaced")
	}
	if users != 1 {
		t.Errorf("users = %d, want 1: one adult is one account", users)
	}
	if guardianOn == nil || *guardianOn != guardian {
		t.Errorf("application guardian_id = %v, want the guardian who already existed", guardianOn)
	}
}

/*
A parent sees their own admission and nobody else's.

	Two families in ONE school, which is the sharp case: row-level security is
	no help at all here -- both applications are rows of the same tenant, and a
	query keyed on anything wider than the caller's own guardian returns both.
	The cross-tenant case is covered by the same query's tenancy scope; this is
	the one a mistake actually reaches.
*/
func TestPortalAdmissionShowsOnlyMyOwnFamily(t *testing.T) {
	db := testDB(t)
	w := seedAdmissionsWorld(t, db, "Two Families School")
	ctx := context.Background()

	type family struct {
		user, guardian, app uuid.UUID
		child               string
	}
	mine := family{uuid.New(), uuid.New(), uuid.New(), "Mine"}
	theirs := family{uuid.New(), uuid.New(), uuid.New(), "Theirs"}

	for i, f := range []family{mine, theirs} {
		f := f
		suffix := f.user.String()[:6]
		err := db.InTenant(ctx, database.Scope{InstitutionID: w.inst}, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `
				INSERT INTO users (id, institution_id, username, full_name, password_hash, status)
				VALUES ($1,$2,$3::citext,$4,'x','active')`,
				f.user, w.inst, "parent"+suffix, "Parent "+f.child); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO guardians (id, institution_id, full_name, relation, phone, user_id)
				VALUES ($1,$2,$3,'father',$4,$5)`,
				f.guardian, w.inst, "Parent "+f.child, "900000100"+string(rune('0'+i)),
				f.user); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `
				INSERT INTO applications (id, institution_id, campus_id, application_no,
				                          first_name, class_sought, parent_name, parent_phone,
				                          status, guardian_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,'9000001000','under_review',$8)`,
				f.app, w.inst, w.campus, "APP-"+suffix, f.child, w.class,
				"Parent "+f.child, f.guardian)
			return err
		})
		if err != nil {
			t.Fatalf("seed family %s: %v", f.child, err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/portal/admission", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(),
		&httpx.Identity{UserID: mine.user, InstitutionID: w.inst}))
	rec := httptest.NewRecorder()
	w.s.getPortalAdmission(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("getPortalAdmission: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items []portalAdmission `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if len(out.Items) != 1 {
		t.Fatalf("got %d admissions, want exactly my own: %s", len(out.Items), rec.Body.String())
	}
	if out.Items[0].ApplicationID != mine.app.String() {
		t.Errorf("application = %s, want mine (%s)", out.Items[0].ApplicationID, mine.app)
	}
	if strings.Contains(rec.Body.String(), "Theirs") {
		t.Errorf("another family's admission is in the response: %s", rec.Body.String())
	}
}

/*
And the tenant boundary itself, forced rather than assumed.

	The other school's parent, with their real user id, presented against THIS
	school -- which is what a stolen session, a mixed-up institution claim or a
	query that trusted user_id alone would look like. Every table here carries
	FORCE ROW LEVEL SECURITY and the scope is set from the identity, so the
	answer has to be nothing at all rather than the other school's admission.
*/
func TestPortalAdmissionNeverCrossesSchools(t *testing.T) {
	db := testDB(t)
	here := seedAdmissionsWorld(t, db, "My School")
	other := seedAdmissionsWorld(t, db, "Other School")
	ctx := context.Background()

	otherUser, otherGuardian, otherApp := uuid.New(), uuid.New(), uuid.New()
	err := db.InTenant(ctx, database.Scope{InstitutionID: other.inst}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO users (id, institution_id, username, full_name, password_hash, status)
			VALUES ($1,$2,'elsewhere'::citext,'Elsewhere Parent','x','active')`,
			otherUser, other.inst); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO guardians (id, institution_id, full_name, relation, phone, user_id)
			VALUES ($1,$2,'Elsewhere Parent','father','9111111111',$3)`,
			otherGuardian, other.inst, otherUser); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO applications (id, institution_id, campus_id, application_no,
			                          first_name, class_sought, parent_name, parent_phone,
			                          status, guardian_id)
			VALUES ($1,$2,$3,'APP-OTHER','Elsewhere',$4,'Elsewhere Parent','9111111111',
			        'offered',$5)`,
			otherApp, other.inst, other.campus, other.class, otherGuardian)
		return err
	})
	if err != nil {
		t.Fatalf("seed other school: %v", err)
	}

	// Their user id, this school's tenancy.
	req := httptest.NewRequest(http.MethodGet, "/portal/admission", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(),
		&httpx.Identity{UserID: otherUser, InstitutionID: here.inst}))
	rec := httptest.NewRecorder()
	here.s.getPortalAdmission(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("getPortalAdmission: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Elsewhere") {
		t.Fatalf("another school's application leaked: %s", rec.Body.String())
	}
	var out struct {
		Items []portalAdmission `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Items) != 0 {
		t.Fatalf("got %d admissions, want none in this school", len(out.Items))
	}
}
