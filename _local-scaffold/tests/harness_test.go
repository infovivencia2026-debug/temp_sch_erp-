// Package tests holds the integration and authorization suites. They run against
// a real PostgreSQL and a real Redis, because the things most worth testing here
// — row-level security, unique constraints, revoked privileges — do not exist in
// a mock.
package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/school-erp/erp/internal/seed"
	"github.com/school-erp/erp/internal/server"
	"github.com/school-erp/erp/migrations"
	"github.com/school-erp/erp/pkg/config"
	"github.com/school-erp/erp/pkg/database"
)

type harness struct {
	server *httptest.Server
	db     *database.DB
	rdb    *redis.Client
}

var h *harness

func TestMain(m *testing.M) {
	adminURL := os.Getenv("TEST_DB_ADMIN_URL")
	appURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" || appURL == "" {
		fmt.Println("skipping integration tests: set TEST_DB_ADMIN_URL and TEST_DATABASE_URL (see Makefile target `test-integration`)")
		os.Exit(0)
	}

	ctx := context.Background()

	// Migrations run as the owner; the server connects as the unprivileged role
	// so RLS applies to it — exactly as in production.
	admin, err := database.Connect(ctx, adminURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect as owner: %v\n", err)
		os.Exit(1)
	}
	appRole := os.Getenv("DB_APP_ROLE")
	if appRole == "" {
		appRole = "schoolerp_app"
	}
	if err := database.Migrate(ctx, admin, migrations.FS, appRole); err != nil {
		fmt.Fprintf(os.Stderr, "migrate: %v\n", err)
		os.Exit(1)
	}
	if err := truncateAll(ctx, admin); err != nil {
		fmt.Fprintf(os.Stderr, "truncate: %v\n", err)
		os.Exit(1)
	}
	if err := seed.Run(ctx, admin); err != nil {
		fmt.Fprintf(os.Stderr, "seed: %v\n", err)
		os.Exit(1)
	}
	admin.Close()

	db, err := database.Connect(ctx, appURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect as app role: %v\n", err)
		os.Exit(1)
	}

	redisAddr := os.Getenv("TEST_REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "127.0.0.1:6379"
	}
	// A dedicated Redis database, flushed on start, so a test run never
	// inherits or clobbers a developer's local sessions.
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr, DB: 15})
	if err := rdb.Ping(ctx).Err(); err != nil {
		fmt.Fprintf(os.Stderr, "redis: %v\n", err)
		os.Exit(1)
	}
	rdb.FlushDB(ctx)

	cfg := config.Config{
		Env:         "dev",
		SessionTTL:  time.Hour,
		LogLevel:    "error", // keep the suite's output about the tests
		CORSOrigins: []string{"http://localhost:3000"},
	}

	h = &harness{
		server: httptest.NewServer(server.New(cfg, db, rdb).Engine),
		db:     db,
		rdb:    rdb,
	}

	code := m.Run()

	h.server.Close()
	db.Close()
	rdb.Close()
	os.Exit(code)
}

// truncateAll resets tenant data between runs while leaving the catalogue —
// permissions and system roles — that migration 0004 installed.
//
// Deliberately DELETE in dependency order rather than TRUNCATE ... CASCADE:
// roles carries a foreign key to organizations, so a cascade would take the
// system roles with it and leave the database unable to authorise anyone.
func truncateAll(ctx context.Context, db *database.DB) error {
	_, err := database.InTx(ctx, db, func(tx database.Tx) (struct{}, error) {
		for _, stmt := range []string{
			`DELETE FROM audit_logs`,
			`DELETE FROM outbox_events`,
			// SIS, innermost first: the foreign keys are RESTRICT on purpose, so
			// nothing here can be deleted out of order.
			`DELETE FROM student_lifecycle_events`,
			`DELETE FROM student_identifiers`,
			`DELETE FROM student_guardians`,
			`DELETE FROM enrollments`,
			`DELETE FROM students`,
			`DELETE FROM guardians`,
			`DELETE FROM section_teachers`,
			`DELETE FROM sections`,
			`DELETE FROM subjects`,
			`DELETE FROM grades`,
			`DELETE FROM houses`,
			`DELETE FROM memberships`,
			`DELETE FROM users`,
			`DELETE FROM academic_years`,
			`DELETE FROM campuses`,
			`DELETE FROM schools`,
			`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE organization_id IS NOT NULL)`,
			`DELETE FROM roles WHERE organization_id IS NOT NULL`,
			`DELETE FROM organizations`,
		} {
			if _, err := tx.Exec(ctx, stmt); err != nil {
				return struct{}{}, fmt.Errorf("%s: %w", stmt, err)
			}
		}
		return struct{}{}, nil
	})
	return err
}

// --- request helpers --------------------------------------------------------

// actor is a signed-in client. Its cookie jar carries the session, so these
// tests exercise the same path a browser does.
type actor struct {
	name   string
	client *http.Client
}

func signIn(t *testing.T, email string) *actor {
	t.Helper()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}

	body := fmt.Sprintf(`{"email":%q,"password":%q}`, email, seed.DevPassword)
	resp, err := client.Post(h.server.URL+"/api/v1/auth/login",
		"application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("login %s: %v", email, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("login %s: status %d: %s", email, resp.StatusCode, raw)
	}
	return &actor{name: email, client: client}
}

// anonymous is a client with no session at all.
func anonymous() *actor {
	return &actor{name: "anonymous", client: &http.Client{Timeout: 10 * time.Second}}
}

type response struct {
	status int
	body   []byte
}

func (r response) code() string {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(r.body, &envelope)
	return envelope.Error.Code
}

func (r response) decodeData(t *testing.T, into any) {
	t.Helper()
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(r.body, &envelope); err != nil {
		t.Fatalf("decode envelope: %v (body: %s)", err, r.body)
	}
	if err := json.Unmarshal(envelope.Data, into); err != nil {
		t.Fatalf("decode data: %v (body: %s)", err, r.body)
	}
}

func (a *actor) do(t *testing.T, method, path, body string) response {
	t.Helper()

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, h.server.URL+path, reader)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := a.client.Do(req)
	if err != nil {
		t.Fatalf("%s %s as %s: %v", method, path, a.name, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return response{status: resp.StatusCode, body: raw}
}

func (a *actor) get(t *testing.T, path string) response {
	return a.do(t, http.MethodGet, path, "")
}

// --- seeded accounts, by role ----------------------------------------------

const (
	orgAdmin    = "priya.nair@vidyaniketan.test"    // organisation-wide
	principal   = "radhika.menon@vidyaniketan.test" // VNPS-HYD
	accountant  = "suresh.kumar@vidyaniketan.test"  // VNPS-HYD
	teacher     = "anitha.reddy@vidyaniketan.test"  // VNPS-HYD
	schoolAdmin = "deepak.varma@vidyaniketan.test"  // VNPS-SEC
	auditor     = "lakshmi.rao@vidyaniketan.test"   // organisation-wide
)

type schoolPayload struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Code string `json:"code"`
}

// schoolIDByCode finds a seeded school, using an actor who can see all of them.
func schoolIDByCode(t *testing.T, code string) string {
	t.Helper()
	admin := signIn(t, orgAdmin)
	resp := admin.get(t, "/api/v1/schools?include_archived=true")
	var schools []schoolPayload
	resp.decodeData(t, &schools)
	for _, s := range schools {
		if s.Code == code {
			return s.ID
		}
	}
	t.Fatalf("seeded school %q not found", code)
	return ""
}
