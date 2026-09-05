package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Two groups, in the shape bus_tracker_test.go established.

	The first needs no database. It covers the decisions that are made in Go
	and can therefore be wrong in Go: the token format, what a key is allowed
	to carry, whether a header can widen a key's tenant, and whether the
	management routes refuse a key. Those are the pieces where a regression
	would be silent.

	The second needs a real Postgres and is skipped without TEST_DATABASE_URL,
	because what it asserts is a property of row level security and of the
	resolver's SQL. A fake database would prove only that the fake obeys the
	rule the real one has to obey.
*/

// --- token format, no database needed ----------------------------------------

func TestAPIKeyTokenSplitsAndRejectsRubbish(t *testing.T) {
	id := uuid.New()
	token, secret, err := newAPIKeyToken(id)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if !strings.HasPrefix(token, apiKeyTokenPrefix+".") {
		t.Errorf("token %q does not carry the erpk prefix a secret scanner looks for", token)
	}
	gotID, gotSecret, ok := splitAPIKeyToken(token)
	if !ok || gotID != id || gotSecret != secret {
		t.Fatalf("round trip: id=%v secret match=%v ok=%v", gotID == id, gotSecret == secret, ok)
	}

	// Two mints must not collide, which is the whole claim of 32 random bytes.
	other, _, _ := newAPIKeyToken(id)
	if other == token {
		t.Error("two mints produced the same token")
	}

	for _, bad := range []string{
		"", "Bearer", "erpk", "erpk.", "erpk." + id.String(), "erpk." + id.String() + ".",
		"erpk.not-a-uuid.secret", "bt." + id.String() + ".secret",
		// The bus tracker's own token shape, which travels to paths under
		// /api/v1 as well. Mistaking one for a key would break the buses.
		"bustrk." + id.String() + ".secret",
	} {
		if _, _, ok := splitAPIKeyToken(bad); ok {
			t.Errorf("accepted %q as an api key token", bad)
		}
	}
}

// The hint is printed on screen beside the name. It must not be enough to
// authenticate with, which means it must stop well short of the secret.
func TestAPIKeyHintDoesNotCarryTheSecret(t *testing.T) {
	token, secret, err := newAPIKeyToken(uuid.New())
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	hint := apiKeyHint(token)
	if strings.Contains(hint, secret) {
		t.Fatalf("the hint %q contains the whole secret", hint)
	}
	if len(hint) >= len(token) {
		t.Errorf("hint %q is not shorter than the token", hint)
	}
}

// --- what a key may carry ----------------------------------------------------

/*
No key may hold a platform permission, whoever issues it.

	This is the check that stops a key being a route to super_admin or
	seller_admin. Those roles are distinguished by the platform.* keys, and a
	key that cannot hold them cannot be either role however it was created.
	Driven off rbac.All rather than a list here, so a platform permission
	added next year is covered by this test on the day it is added.
*/
func TestAPIKeyRefusesEveryPlatformPermission(t *testing.T) {
	platform := 0
	for _, p := range rbac.All {
		if p.Module == "platform" {
			platform++
			if !apiKeyPermissionForbidden(p.Key) {
				t.Errorf("%s is a platform permission and an API key would be allowed to carry it", p.Key)
			}
			continue
		}
		if apiKeyPermissionForbidden(p.Key) {
			t.Errorf("%s is an ordinary school permission and a key is refused it", p.Key)
		}
	}
	if platform == 0 {
		t.Fatal("no permission in rbac.All is in the platform module; this test is asserting nothing")
	}
	// A key naming something that is not a permission at all is refused
	// rather than stored, so it cannot become live the day somebody seeds a
	// permission with that name.
	for _, made := range []string{"", "platform.everything", "students.read.all.all", "*"} {
		if !apiKeyPermissionForbidden(made) {
			t.Errorf("%q is not in the permission vocabulary and was allowed", made)
		}
	}
}

/*
The effective set is an intersection, never a union.

	The stored list is frozen at issue. What the school grants moves
	afterwards, and both directions matter: a permission the school withdraws
	must stop working for the key, and a permission the school gains must not
	appear in a key that never asked for it.
*/
func TestAPIKeyPermissionsAreIntersectedNotUnioned(t *testing.T) {
	stored := []string{rbac.StudentsRead, rbac.FeesRead, rbac.PlatformTenantsRW}
	granted := []string{rbac.StudentsRead, rbac.InvoicesWrite, rbac.PlatformTenantsRW}

	got := apiKeyEffectivePermissions(stored, granted)

	if _, ok := got[rbac.StudentsRead]; !ok {
		t.Error("students.read is in both lists and was dropped")
	}
	if _, ok := got[rbac.FeesRead]; ok {
		t.Error("finance.fees.read was withdrawn from the school and the key kept it")
	}
	if _, ok := got[rbac.InvoicesWrite]; ok {
		t.Error("the school grants finance.invoices.write and the key gained it without asking")
	}
	if _, ok := got[rbac.PlatformTenantsRW]; ok {
		t.Fatal("a platform permission survived into a key even though both lists carried it; " +
			"this is the escalation the whole feature must not allow")
	}

	id := &httpx.Identity{Permissions: got}
	if id.Can(rbac.PlatformTenantsRW) || id.Can(rbac.InvoicesWrite) {
		t.Error("Identity.Can admits a permission the effective set does not hold")
	}
}

/*
THE CROSS-TENANT CASE, in the one place it can be decided without a database.

	A key's institution comes from its own row. The only mechanism in the
	product that can move a request to another school is the acting-
	institution header, and it is meant to be ignored for anybody who is not
	platform staff. A key is never platform staff, so this asserts the two
	halves together: the identity a key produces has PlatformAdmin false, and
	a request carrying school B's id in the header still runs against school
	A.

	If somebody ever sets PlatformAdmin on a key identity, this test fails
	here rather than in production, where the symptom would be one school's
	integration reading another school's roll.
*/
func TestAPIKeyIdentityCannotBeMovedToAnotherSchoolByAHeader(t *testing.T) {
	schoolA, schoolB := uuid.New(), uuid.New()
	key := &httpx.Identity{
		UserID:        uuid.New(),
		InstitutionID: schoolA,
		APIKey:        true,
		APIKeyID:      uuid.New(),
		Permissions:   map[string]struct{}{rbac.StudentsRead: {}},
	}
	if key.PlatformAdmin {
		t.Fatal("an API key identity must never be platform staff")
	}
	if sc := tenantScope(key); sc.PlatformAdmin || sc.InstitutionID != schoolA {
		t.Fatalf("tenant scope for a key: got %+v, want institution %v and no platform reach", sc, schoolA)
	}

	var seen database.Scope
	h := ActingInstitution(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = tenantScope(httpx.IdentityFrom(r.Context()))
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/students?institution_id="+schoolB.String(), nil)
	req.Header.Set("X-Acting-Institution", schoolB.String())
	h.ServeHTTP(httptest.NewRecorder(), req.WithContext(httpx.WithIdentity(req.Context(), key)))

	if seen.InstitutionID != schoolA {
		t.Fatalf("a header moved a key from school %v to %v", schoolA, seen.InstitutionID)
	}
	if seen.PlatformAdmin {
		t.Fatal("a key acquired platform reach")
	}
}

// --- the middleware ----------------------------------------------------------

/*
The middleware is transparent everywhere it must be.

	s.DB is nil throughout, so any call that reaches the resolver panics and
	the test fails loudly rather than passing for the wrong reason.

	Three passes matter. A bearer token outside /api/v1 must not authenticate
	anything, or a key would drive the login form and the server-rendered
	pages, whose CSRF handling assumes a cookie. A request with no
	Authorization header must be left exactly as it was, which is the whole
	SPA. And a bearer token that is not one of ours must pass through
	untouched, because the bus tracker and the SMS gateway send those to
	paths under /api/v1 and authenticate themselves further in.
*/
func TestAPIKeyAuthLeavesEveryOtherCallerAlone(t *testing.T) {
	s := &Server{}
	reached := false
	h := s.APIKeyAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		if id := httpx.IdentityFrom(r.Context()); id != nil {
			t.Errorf("%s picked up an identity it should not have", r.URL.Path)
		}
	}))

	token, _, _ := newAPIKeyToken(uuid.New())
	for _, c := range []struct{ path, auth string }{
		{"/login", token},
		{"/buy", token},
		{"/api/v1/session", ""},
		{"/api/v1/bus-tracker/ping", "bustrk." + uuid.NewString() + ".secret"},
		{"/api/v1/session", "Basic abc"},
	} {
		reached = false
		req := httptest.NewRequest(http.MethodGet, c.path, nil)
		if c.auth != "" {
			req.Header.Set("Authorization", "Bearer "+c.auth)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if !reached {
			t.Errorf("%s with auth %q never reached the handler (status %d)", c.path, c.auth, rec.Code)
		}
	}
}

/*
A key may not manage keys.

	Walks the real router that api.go mounts, so a route added to
	mountAPIKeys later without the guard fails here. The permission is
	deliberately present on the identity: this refusal is about the
	credential, not about the rights, and testing it with a caller who lacks
	the permission would prove nothing.
*/
func TestAPIKeyCallerCannotIssueOrRevokeKeys(t *testing.T) {
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		(&Server{}).mountAPIKeys(r)
	})

	key := &httpx.Identity{
		UserID:        uuid.New(),
		InstitutionID: uuid.New(),
		APIKey:        true,
		APIKeyID:      uuid.New(),
		Permissions: map[string]struct{}{
			rbac.UsersRead: {}, rbac.UsersWrite: {},
		},
	}
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api-keys/"},
		{http.MethodPost, "/api-keys/"},
		{http.MethodPost, "/api-keys/" + uuid.NewString() + "/revoke"},
	} {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req.WithContext(httpx.WithIdentity(req.Context(), key)))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s from a key: got %d, want 403", c.method, c.path, rec.Code)
		}
	}
}

// --- the limiter -------------------------------------------------------------

/*
The limiter counts per key and forgets at the window edge.

	Per key, not per institution: a school's reporting export must not be
	stopped by its attendance sync misbehaving, and the owner sets the number
	on the key precisely so the two can differ.
*/
func TestAPIKeyLimiterCountsPerKeyAndResets(t *testing.T) {
	// A Server with nothing set counts in its own in-memory store, and its
	// Clock is what the limiter reads, so the minute is walked by hand.
	now := time.Now()
	s := &Server{Clock: func() time.Time { return now }}
	ctx := context.Background()
	l := func(id uuid.UUID, perMinute int, at time.Time) (bool, time.Duration) {
		now = at
		return s.allowAPIKeyRequest(ctx, id, perMinute)
	}
	a, b := uuid.New(), uuid.New()

	for i := 0; i < 3; i++ {
		if ok, _ := l(a, 3, now); !ok {
			t.Fatalf("request %d of 3 was refused", i+1)
		}
	}
	ok, retry := l(a, 3, now)
	if ok {
		t.Fatal("the fourth request in a minute was allowed against a limit of 3")
	}
	if retry <= 0 || retry > time.Minute {
		t.Errorf("retry-after %v is not inside the window", retry)
	}
	if ok, _ := l(b, 3, now); !ok {
		t.Error("a second key was refused because the first had spent its budget")
	}
	if ok, _ := l(a, 3, now.Add(time.Minute)); !ok {
		t.Error("the window did not reset after a minute")
	}
}

// --- with a database ---------------------------------------------------------

type apiKeySchool struct {
	inst uuid.UUID
	user uuid.UUID
	role uuid.UUID
	key  uuid.UUID
	tok  string
}

/*
The cross-tenant proof, against a real Postgres and real RLS.

	Skipped without TEST_DATABASE_URL. Everything here is a property of the
	resolver's SQL and of the tenant policy on api_keys, and the only useful
	way to assert it is against the database that enforces it.

	Two schools, a key in each. The assertions are the ones that would be
	reported as a breach if they failed: a key resolves to its own school and
	to no platform reach; the tenant scope it produces sees its own key row
	and not the other school's; revoking the other school's key by id is a
	404 and changes nothing; and a revoked key is refused on the very next
	call, with no cache in between.
*/
func TestAPIKeyIsConfinedToItsOwnSchool(t *testing.T) {
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
	s := &Server{DB: db}

	/* The connection must be one the policies bind.

	   Postgres exempts a superuser, and any role with BYPASSRLS, from every
	   row-level policy; FORCE ROW LEVEL SECURITY reaches the table owner but
	   not those. Run against such a role, the visibility assertion below
	   fails and reports a tenant breach that does not exist, which is a bad
	   way to spend an afternoon. The production pools connect as the
	   unprivileged app_user (internal/database/db.go), and this test needs
	   the same: a failure here is the harness pointing at the wrong role,
	   not the schema. */
	var bypasses bool
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT rolsuper OR rolbypassrls FROM pg_roles
			 WHERE rolname = current_user`).Scan(&bypasses)
	}); err != nil {
		t.Fatalf("inspect the connection role: %v", err)
	}
	if bypasses {
		t.Fatal("TEST_DATABASE_URL connects as a superuser or BYPASSRLS role, which " +
			"Postgres exempts from row-level security; point it at the unprivileged " +
			"app role (app_user) so the tenant policies under test actually apply")
	}

	newSchool := func(label string) *apiKeySchool {
		sc := &apiKeySchool{}
		suffix := uuid.NewString()[:8]
		if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `
				INSERT INTO institutions (name, short_name, slug)
				VALUES ($1,$2,$3) RETURNING id`,
				"Key Test "+label, "KT"+label, "key-"+label+"-"+suffix).Scan(&sc.inst); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO users (institution_id, email, full_name, status)
				VALUES ($1,$2,'Key Owner','active') RETURNING id`,
				sc.inst, "key-"+label+"-"+suffix+"@example.test").Scan(&sc.user); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO roles (institution_id, key, name)
				VALUES ($1,'institution_admin','Principal') RETURNING id`,
				sc.inst).Scan(&sc.role); err != nil {
				return err
			}
			/* The vocabulary itself, because role_permissions has a foreign
			   key to it and a freshly migrated database has not been seeded.
			   Harmless against a seeded one: the row is already there. */
			if _, err := tx.Exec(ctx, `
				INSERT INTO permissions (key, module, description)
				VALUES ($1,'students','View students') ON CONFLICT DO NOTHING`,
				rbac.StudentsRead); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO role_permissions (role_id, permission_key)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, sc.role, rbac.StudentsRead); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO api_keys (institution_id, name, token_hash, permissions, created_by)
				VALUES ($1,$2,'\x00'::bytea,$3,$4) RETURNING id`,
				sc.inst, "integration-"+label,
				[]string{rbac.StudentsRead}, sc.user).Scan(&sc.key); err != nil {
				return err
			}
			var secret string
			sc.tok, secret, err = newAPIKeyToken(sc.key)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `UPDATE api_keys SET token_hash = $2 WHERE id = $1`,
				sc.key, hashAPIKeySecret(secret))
			return err
		}); err != nil {
			t.Fatalf("set up school %s: %v", label, err)
		}
		t.Cleanup(func() {
			_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
				_, err := tx.Exec(context.Background(),
					`DELETE FROM institutions WHERE id = $1`, sc.inst)
				return err
			})
		})
		return sc
	}

	a, b := newSchool("a"), newSchool("b")

	keyID, secret, ok := splitAPIKeyToken(a.tok)
	if !ok {
		t.Fatal("the token just minted does not parse")
	}
	res, err := s.resolveAPIKey(ctx, keyID, secret)
	if err != nil {
		t.Fatalf("resolve school A's key: %v", err)
	}
	if res.InstitutionID != a.inst {
		t.Fatalf("key resolved to institution %v, want %v", res.InstitutionID, a.inst)
	}
	if res.PlatformAdmin {
		t.Fatal("a key resolved to a platform administrator")
	}
	if !res.Can(rbac.StudentsRead) {
		t.Error("the key lost the permission its school grants it")
	}
	if res.Can(rbac.PlatformTenantsRW) || res.Can(rbac.FeesRead) {
		t.Error("the key holds a permission neither it nor its school was given")
	}

	// A wrong secret against a real key id is refused, and so is a real
	// secret against another school's key id.
	if _, err := s.resolveAPIKey(ctx, keyID, secret+"x"); err == nil {
		t.Error("a wrong secret authenticated")
	}
	if _, err := s.resolveAPIKey(ctx, b.key, secret); err == nil {
		t.Error("school A's secret authenticated against school B's key id")
	}

	/* RLS, from inside school A. The listing query the handler runs must not
	   see school B's key, and must not merely return it with a different
	   institution_id. */
	var visible int
	if err := db.InTenant(ctx, tenantScope(res.Identity), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM api_keys WHERE id = $1`, b.key).Scan(&visible)
	}); err != nil {
		t.Fatalf("read under school A's scope: %v", err)
	}
	if visible != 0 {
		t.Fatalf("school A can see school B's api key row (%d rows); "+
			"the tenant policy on api_keys is not doing its job", visible)
	}

	/* END TO END, through the header and the real gates.

	   Everything above tests the resolver directly. This drives an HTTP
	   request carrying school A's key through APIKeyAuth, RequireAuth and
	   RequirePermission into a handler that reads a tenant table under
	   tenantScope, which is the arrangement every real endpoint has. Asking
	   for school B's row must answer 404 and not a 200 with nothing in it:
	   an empty success tells an integration its query was fine and the data
	   is gone, which is how a cross-tenant leak gets reported as a bug in
	   the wrong system for a fortnight. */
	fetch := chi.NewRouter()
	fetch.Use(s.APIKeyAuth, httpx.RequireAuth, httpx.RequirePermission(rbac.StudentsRead))
	fetch.Get("/api/v1/thing/{id}", func(w http.ResponseWriter, rq *http.Request) {
		caller := httpx.IdentityFrom(rq.Context())
		want := uuid.MustParse(chi.URLParam(rq, "id"))
		var name string
		err := db.InTenant(rq.Context(), tenantScope(caller), func(tx pgx.Tx) error {
			return tx.QueryRow(rq.Context(),
				`SELECT name FROM api_keys WHERE id = $1`, want).Scan(&name)
		})
		if err != nil {
			httpx.NotFound(w, rq)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"name": name})
	})

	call := func(target uuid.UUID) *httptest.ResponseRecorder {
		rq := httptest.NewRequest(http.MethodGet, "/api/v1/thing/"+target.String(), nil)
		rq.Header.Set("Authorization", "Bearer "+a.tok)
		rr := httptest.NewRecorder()
		fetch.ServeHTTP(rr, rq)
		return rr
	}
	if rr := call(a.key); rr.Code != http.StatusOK {
		t.Fatalf("school A reading its own row with its own key: got %d, want 200 (%s)",
			rr.Code, rr.Body.String())
	}
	if rr := call(b.key); rr.Code != http.StatusNotFound {
		t.Fatalf("school A reading school B's row with an API key: got %d, want 404 (%s)",
			rr.Code, rr.Body.String())
	}

	/* Revoking across the boundary. A 404 is required rather than a silent
	   success or an empty 200: the caller must not be able to learn that the
	   id names a key belonging to somebody else, and school B's key must
	   still be live afterwards. */
	admin := &httpx.Identity{
		UserID: a.user, InstitutionID: a.inst,
		Permissions: map[string]struct{}{rbac.UsersRead: {}, rbac.UsersWrite: {}},
	}
	r := chi.NewRouter()
	s.mountAPIKeys(r)

	req := httptest.NewRequest(http.MethodPost, "/api-keys/"+b.key.String()+"/revoke", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(httpx.WithIdentity(req.Context(), admin)))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("school A revoking school B's key: got %d, want 404", rec.Code)
	}
	var stillLive bool
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT revoked_at IS NULL FROM api_keys WHERE id = $1`, b.key).Scan(&stillLive)
	}); err != nil {
		t.Fatalf("read school B's key: %v", err)
	}
	if !stillLive {
		t.Fatal("school A revoked school B's key")
	}

	// The listing from school A names only school A's key.
	req = httptest.NewRequest(http.MethodGet, "/api-keys/", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(httpx.WithIdentity(req.Context(), admin)))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: got %d, want 200", rec.Code)
	}
	var listed struct {
		Keys []apiKeyView `json:"api_keys"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	for _, k := range listed.Keys {
		if k.ID == b.key.String() {
			t.Fatal("school B's key appears in school A's list")
		}
	}

	/* Revocation with no cache in between. The key authenticated a few lines
	   above; after this call the very next resolve must fail. */
	req = httptest.NewRequest(http.MethodPost, "/api-keys/"+a.key.String()+"/revoke", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(httpx.WithIdentity(req.Context(), admin)))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoking own key: got %d, want 200", rec.Code)
	}
	if _, err := s.resolveAPIKey(ctx, keyID, secret); err == nil {
		t.Fatal("a revoked key still authenticates")
	}

	/* ISSUING, which is where the subset rule is first enforced.

	   School A grants students.read to a role and nothing else, so a key
	   asking for finance.fees.read must be refused rather than quietly
	   trimmed: a key that comes back missing half of what was asked for
	   fails later, in production, with a 403 nobody can account for. The
	   platform key is refused for the harder reason. */
	issue := func(body string) *httptest.ResponseRecorder {
		rq := httptest.NewRequest(http.MethodPost, "/api-keys/", strings.NewReader(body))
		rq.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, rq.WithContext(httpx.WithIdentity(rq.Context(), admin)))
		return rr
	}
	if rr := issue(`{"name":"tally","permissions":["` + rbac.PlatformTenantsRW + `"]}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("issuing a key holding a platform permission: got %d, want 400 (%s)", rr.Code, rr.Body.String())
	}
	if rr := issue(`{"name":"tally","permissions":["` + rbac.FeesRead + `"]}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("issuing a key holding a permission the school does not grant: got %d, want 400 (%s)",
			rr.Code, rr.Body.String())
	}
	rr := issue(`{"name":"tally","permissions":["` + rbac.StudentsRead + `","` + rbac.StudentsRead + `"]}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("issuing an ordinary key: got %d, want 201 (%s)", rr.Code, rr.Body.String())
	}
	var issued struct {
		Token       string   `json:"token"`
		Permissions []string `json:"permissions"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &issued); err != nil {
		t.Fatalf("decode issue response: %v", err)
	}
	if len(issued.Permissions) != 1 {
		t.Errorf("a duplicated permission was stored twice: %v", issued.Permissions)
	}
	newID, newSecret, ok := splitAPIKeyToken(issued.Token)
	if !ok {
		t.Fatalf("the issued token does not parse: %q", issued.Token)
	}
	live, err := s.resolveAPIKey(ctx, newID, newSecret)
	if err != nil {
		t.Fatalf("the key just issued does not authenticate: %v", err)
	}
	if live.InstitutionID != a.inst || live.PlatformAdmin || !live.Can(rbac.StudentsRead) {
		t.Fatalf("issued key resolved wrong: inst=%v platform=%v", live.InstitutionID, live.PlatformAdmin)
	}
	// The name is unique among live keys, so a second one is a conflict and
	// not a silent second credential nobody can tell from the first.
	if rr := issue(`{"name":"tally","permissions":["` + rbac.StudentsRead + `"]}`); rr.Code != http.StatusConflict {
		t.Errorf("a second live key of the same name: got %d, want 409", rr.Code)
	}
	// And the stored hash is not the token: a database dump must not replay.
	var stored []byte
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT token_hash FROM api_keys WHERE id = $1`, newID).Scan(&stored)
	}); err != nil {
		t.Fatalf("read the stored hash: %v", err)
	}
	if strings.Contains(string(stored), newSecret) {
		t.Fatal("the secret itself is in the token_hash column")
	}
}
