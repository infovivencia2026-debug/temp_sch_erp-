package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
The gates in front of the platform signals, the gateway keys and the reader
fleet, following classroom_test.go: the first group drives the routers the
mounts actually build and needs no database, the second needs Postgres and is
skipped without TEST_DATABASE_URL.
*/

func mountedPlatformExtras(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		s.mountPlatformDevices(r)
		s.mountPlatformSignals(r)
	})
	return r
}

var platformExtraRoutes = []struct{ method, path string }{
	{http.MethodGet, "/connectors/payment-gateways"},
	{http.MethodPut, "/connectors/payment-gateways"},
	{http.MethodDelete, "/connectors/payment-gateways/" + uuid.NewString()},
	{http.MethodGet, "/biometric-devices"},
	{http.MethodGet, "/signals/dropout-risk"},
	{http.MethodGet, "/signals/cash-flow"},
}

// A school account holding nothing reaches none of it.
func TestPlatformExtrasRefuseACallerWithNoPermissions(t *testing.T) {
	h := mountedPlatformExtras(&Server{}, identityWith())
	for _, tc := range platformExtraRoutes {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}")))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
}

/*
An institution admin who somehow holds the vendor permission is still refused:
every read here crosses tenants, and platformOnly is the second lock. The RLS
policy on payment_gateway_credentials closes the same door a third time; the
handler must never be the only thing standing.
*/
func TestPlatformExtrasRefuseATenantWithTheVendorKey(t *testing.T) {
	h := mountedPlatformExtras(&Server{}, identityWith(rbac.PlatformTenantsRW))
	for _, tc := range platformExtraRoutes {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}")))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
}

// A platform account is refused a gateway it has never heard of before any
// database is touched — the sentence names the five, not a constraint.
func TestSavePaymentGatewayRefusesAnUnknownProvider(t *testing.T) {
	id := identityWith(rbac.PlatformTenantsRW)
	id.PlatformAdmin = true
	id.InstitutionID = uuid.Nil
	h := mountedPlatformExtras(&Server{}, id)
	for _, body := range []string{
		`{"provider":"stripe"}`,
		`{"provider":"razorpay","mode":"sandbox"}`,
		`{"provider":"razorpay","institution_id":"not-a-uuid"}`,
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/connectors/payment-gateways", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", body, rec.Code)
		}
	}
}

// --- the blueprint draw -------------------------------------------------------

func mountedTeachingForCompose(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) { s.mountTeaching(r) })
	return r
}

// A malformed blueprint is refused before scope is resolved, so no database
// is needed to prove each rule.
func TestComposePaperRefusesABadBlueprint(t *testing.T) {
	h := mountedTeachingForCompose(&Server{}, identityWith(rbac.HomeworkWrite))
	cs := uuid.NewString()
	for _, body := range []string{
		`{"class_subject_id":"","rows":[{"count":1}]}`,
		`{"class_subject_id":"` + cs + `","rows":[]}`,
		`{"class_subject_id":"` + cs + `","rows":[{"count":0}]}`,
		`{"class_subject_id":"` + cs + `","rows":[{"count":51}]}`,
		`{"class_subject_id":"` + cs + `","rows":[{"count":1,"difficulty":"brutal"}]}`,
		`{"class_subject_id":"` + cs + `","rows":[{"count":1,"kind":"essay"}]}`,
		`{"class_subject_id":"` + cs + `","rows":[{"count":1,"syllabus_unit_id":"ch3"}]}`,
		`{"class_subject_id":"` + cs + `","rows":[{"count":1,"marks":-2}]}`,
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/question-bank/compose", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", body, rec.Code)
		}
	}
}

/*
The draw itself, against Postgres.

	One subject, six questions: four easy one-markers and two hard five-markers.
	A blueprint asking for three easy and three hard must return three and two,
	report one short, never repeat a question, and total 13 marks.
*/
func TestComposePaperDrawsFromTheBank(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	db, err := database.Connect(ctx, url, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)

	var inst uuid.UUID
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO institutions (name, short_name, slug)
			VALUES ('Compose Test','Comp',$1) RETURNING id`,
			"cp-"+uuid.NewString()[:8]).Scan(&inst)
	}); err != nil {
		t.Fatalf("institution: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(), `DELETE FROM institutions WHERE id = $1`, inst)
			return err
		})
	})

	var cs uuid.UUID
	if err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		var campus, class, subject uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO campuses (institution_id, name, code)
			VALUES ($1,'Main','MAIN') RETURNING id`, inst).Scan(&campus); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO classes (institution_id, campus_id, name, level)
			VALUES ($1,$2,'Grade 8',8) RETURNING id`, inst, campus).Scan(&class); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO subjects (institution_id, campus_id, name, code)
			VALUES ($1,$2,'Science','SCI') RETURNING id`, inst, campus).Scan(&subject); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO class_subjects (institution_id, class_id, subject_id)
			VALUES ($1,$2,$3) RETURNING id`, inst, class, subject).Scan(&cs); err != nil {
			return err
		}
		for i := 0; i < 4; i++ {
			if _, err := tx.Exec(ctx, `INSERT INTO question_bank_questions
				(institution_id, class_subject_id, kind, difficulty, stem, default_marks)
				VALUES ($1,$2,'short','easy',$3,1)`, inst, cs, "easy "+itoa(i)); err != nil {
				return err
			}
		}
		for i := 0; i < 2; i++ {
			if _, err := tx.Exec(ctx, `INSERT INTO question_bank_questions
				(institution_id, class_subject_id, kind, difficulty, stem, default_marks)
				VALUES ($1,$2,'long','hard',$3,5)`, inst, cs, "hard "+itoa(i)); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// A platform account inside the school sees every subject, which is what
	// the scope resolver hands anybody not narrowed to their own sections.
	id := identityWith(rbac.HomeworkWrite)
	id.InstitutionID = inst
	id.PlatformAdmin = true
	h := mountedTeachingForCompose(&Server{DB: db}, id)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/question-bank/compose", strings.NewReader(
		`{"class_subject_id":"`+cs.String()+`","rows":[{"difficulty":"easy","count":3},{"difficulty":"hard","count":3}]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("compose: got %d: %s", rec.Code, rec.Body.String())
	}
	var out composedPaper
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Sections) != 2 || out.Sections[0].Found != 3 || out.Sections[1].Found != 2 {
		t.Fatalf("sections: %+v", out.Sections)
	}
	if out.Short != 1 || out.Questions != 5 || out.TotalMarks != 13 {
		t.Errorf("short=%d questions=%d marks=%v; want 1, 5, 13", out.Short, out.Questions, out.TotalMarks)
	}
	seen := map[string]bool{}
	for _, sec := range out.Sections {
		for _, q := range sec.Questions {
			if seen[q.ID] {
				t.Errorf("question %s drawn twice", q.ID)
			}
			seen[q.ID] = true
		}
	}
}
