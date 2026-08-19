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

/*
The tenancy boundary of the integrations index, pinned before the screen exists.

	This index is a read across every connector at once, which makes it the
	single place in the product where getting tenancy wrong leaks the most in
	one response. Two distinct mistakes are possible and both are pinned here:

	  1. Showing an institution admin a platform connector. The CRM key, the
	     meeting provider account and the Child Info portal connectors are the
	     vendor's, not the school's — crm_api_credentials,
	     virtual_meeting_platform_providers and child_info_portal_connectors all
	     carry an RLS policy of app_is_platform_admin() with no tenant limb. A
	     school administrator must not learn that they exist, let alone their
	     state. Absent, not blanked.

	  2. Showing one school another's connector state. Every per-school query
	     names institution_id explicitly even inside InTenant, because a
	     platform admin's tenant scope is wide open and RLS would happily return
	     the union.

	The database group is guarded on ERP_TEST_DATABASE_URL exactly as
	message_dispatch_test.go's is, so `go test ./internal/...` stays green on a
	machine with no Postgres. testDB and identityWith already exist in this
	package and are reused rather than redeclared.
*/

// mountedIntegrationsIndex builds the index as api.go does: inside /admin,
// which carries no group-level permission, so the route must bring its own.
func mountedIntegrationsIndex(s *Server, id *httpx.Identity) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(httpx.WithIdentity(req.Context(), id)))
		})
	})
	r.Group(func(r chi.Router) {
		s.mountIntegrationsIndex(r)
	})
	return r
}

type indexResponse struct {
	Items []struct {
		Key        string `json:"key"`
		Label      string `json:"label"`
		Scope      string `json:"scope"`
		Provider   string `json:"provider"`
		Configured bool   `json:"configured"`
		Reason     string `json:"reason"`
		Health     string `json:"health"`
		FixKey     string `json:"fix_key"`
	} `json:"items"`
	InstitutionSelected bool `json:"institution_selected"`
	PlatformView        bool `json:"platform_view"`
}

// --- the gate, which needs no database ---------------------------------------

/*
A caller holding nothing gets 403, not an empty index.

	The distinction matters on this screen more than most: an empty index and a
	refused index look identical to a careless client, and one of them says
	"this school has no integrations" about a school that has eight.
*/
func TestIntegrationsIndexRefusesACallerWithNoPermissions(t *testing.T) {
	h := mountedIntegrationsIndex(&Server{}, identityWith())
	if got := statusOf(t, h, http.MethodGet, "/integrations/index"); got != http.StatusForbidden {
		t.Errorf("GET /integrations/index with no permissions: got %d, want 403", got)
	}
}

// institution.read is the gate, and it is the same rung messaging.go already
// uses for "seeing how any of it is configured". Anything but 403 means the
// request reached a handler, which is all this asserts.
func TestIntegrationsIndexAdmitsInstitutionRead(t *testing.T) {
	h := mountedIntegrationsIndex(&Server{}, identityWith(rbac.InstitutionRead))
	if got := statusOf(t, h, http.MethodGet, "/integrations/index"); got == http.StatusForbidden {
		t.Error("GET /integrations/index with institution.read was refused; it is the read gate")
	}
}

// --- the tenancy boundary, which does ----------------------------------------

func TestIntegrationsIndexTenancy(t *testing.T) {
	db := testDB(t)
	s := &Server{DB: db}
	schoolA := seedIndexSchool(t, db, "Index Test School A")
	schoolB := seedIndexSchool(t, db, "Index Test School B")

	// Platform-only state, in all three platform tables. If any of it reaches
	// an institution admin's response, the assertions below fail.
	seedPlatformConnectors(t, db)

	// Per-school state that must not cross: A names a Tally company, B does
	// not, and each gets an SMTP row with a host only it should see.
	seedTallyCompany(t, db, schoolA, "Aurora Vidyalaya Books")
	seedSMTP(t, db, schoolA, "mail.school-a.test")
	seedSMTP(t, db, schoolB, "mail.school-b.test")

	t.Run("an institution admin sees no platform connector at all", func(t *testing.T) {
		/* Deliberately over-permissioned: this identity holds every key a real
		   school administrator could ever carry, including integrations.write,
		   and still must not see a vendor credential's existence. The line is
		   platform.tenants.write, which institution_admin does not hold
		   (rbac.keysExcept). */
		id := identityWith(rbac.InstitutionRead, rbac.IntegrationsWrite,
			rbac.SettingsWrite, rbac.AuditRead)
		id.InstitutionID = schoolA

		out := getIndex(t, s, id)

		if out.PlatformView {
			t.Error("platform_view is true for an institution admin")
		}
		for _, it := range out.Items {
			if it.Scope == "platform" {
				t.Errorf("institution admin was shown platform connector %q (%s)", it.Key, it.Label)
			}
			if strings.HasPrefix(it.Key, "crm") ||
				strings.HasPrefix(it.Key, "meetings") ||
				strings.HasPrefix(it.Key, "child_info") {
				t.Errorf("institution admin was shown %q, which is a vendor connector", it.Key)
			}
		}
		if len(out.Items) == 0 {
			t.Fatal("no items at all; the per-school half should still be present")
		}
	})

	t.Run("restricted platform staff see no platform connector either", func(t *testing.T) {
		/* A vendor's billing administrator: platform-wide reach, but only the
		   permissions actually granted to them. Reach alone must not open the
		   CRM key and the meeting account — the index asks for the capability
		   separately, which is the whole point of httpx.Identity.Restricted. */
		id := identityWith(rbac.InstitutionRead)
		id.InstitutionID = schoolA
		id.PlatformAdmin = true
		id.Restricted = true

		out := getIndex(t, s, id)
		if out.PlatformView {
			t.Error("platform_view is true for restricted platform staff holding no platform.tenants.write")
		}
		for _, it := range out.Items {
			if it.Scope == "platform" {
				t.Errorf("restricted platform staff were shown platform connector %q", it.Key)
			}
		}
	})

	t.Run("unrestricted platform staff do see them", func(t *testing.T) {
		// The complement of the two tests above. Without this, they would also
		// pass against a handler that returned nothing to anybody.
		id := identityWith(rbac.InstitutionRead, rbac.PlatformTenantsRW)
		id.InstitutionID = schoolA
		id.PlatformAdmin = true

		out := getIndex(t, s, id)
		if !out.PlatformView {
			t.Fatal("platform_view is false for platform staff holding platform.tenants.write")
		}
		var sawCRM, sawMeetings, sawChildInfo bool
		for _, it := range out.Items {
			switch {
			case it.Key == "crm":
				sawCRM = true
			case it.Key == "meetings":
				sawMeetings = true
			case strings.HasPrefix(it.Key, "child_info."):
				sawChildInfo = true
			}
		}
		if !sawCRM || !sawMeetings || !sawChildInfo {
			t.Errorf("platform staff missing rows: crm=%v meetings=%v child_info=%v",
				sawCRM, sawMeetings, sawChildInfo)
		}
	})

	t.Run("one school never sees another's connector state", func(t *testing.T) {
		idA := identityWith(rbac.InstitutionRead)
		idA.InstitutionID = schoolA
		idB := identityWith(rbac.InstitutionRead)
		idB.InstitutionID = schoolB

		outA, outB := getIndex(t, s, idA), getIndex(t, s, idB)

		tally := func(out indexResponse) (bool, string) {
			for _, it := range out.Items {
				if it.Key == "tally" {
					return it.Configured, it.Reason
				}
			}
			return false, "no tally row"
		}

		aConfigured, _ := tally(outA)
		bConfigured, bReason := tally(outB)
		if !aConfigured {
			t.Error("school A named a Tally company but its row reports not configured")
		}
		if bConfigured {
			t.Error("school B named no Tally company but its row reports configured; " +
				"that is school A's state leaking across")
		}
		if bReason == "" {
			t.Error("school B's unconfigured Tally row carries no reason; " +
				"the sentence naming the missing setting is the point of the screen")
		}

		// And nothing anywhere in either body mentions the other's mail host.
		assertBodyExcludes(t, s, idA, "school-b.test")
		assertBodyExcludes(t, s, idB, "school-a.test")
	})

	t.Run("platform staff acting on one school do not get the union", func(t *testing.T) {
		/* The case RLS cannot catch, and the reason every per-school query
		   names institution_id explicitly even inside InTenant. A platform
		   admin's tenant scope carries PlatformAdmin, so the tenant policy on
		   integrations and tally_connector_settings is wide open: a query that
		   relied on RLS alone would fold school A's configured Tally company
		   into school B's row and report B as ready to export.

		   School B has no Tally company. Acting on B, that must still be the
		   answer even though A's row is visible to the connection. */
		id := identityWith(rbac.InstitutionRead, rbac.PlatformTenantsRW)
		id.InstitutionID = schoolB
		id.PlatformAdmin = true

		out := getIndex(t, s, id)
		if !out.InstitutionSelected {
			t.Fatal("institution_selected is false while acting on a school")
		}
		for _, it := range out.Items {
			if it.Key == "tally" && it.Configured {
				t.Error("acting on school B, the Tally row reports configured; " +
					"school A's company name has been read across the tenant boundary")
			}
		}
		// A's mail host is a row in `integrations` that this connection can
		// legitimately read. It must not appear in B's response.
		assertBodyExcludes(t, s, id, "school-a.test")
	})

	t.Run("no credential material is ever in the body", func(t *testing.T) {
		/* Every identity, including the one that can see everything. A secret
		   that leaked only to platform staff would still be a secret in a
		   response body, a browser cache and whatever proxy sits between.

		   The needles are values, not vocabulary. The English word
		   "credentials" appears legitimately in several of the sentences this
		   index carries verbatim — "no portal credentials have been entered"
		   is the whole point of surfacing them — so asserting on the word
		   would fail on the feature working correctly. What must never appear
		   is the stored secret and, one rung softer, the vendor account
		   identifiers beside it: a base URL, an account reference and a portal
		   username are not secrets, but they are the vendor's, and a screen
		   that needs only a boolean has no business carrying them. */
		id := identityWith(rbac.InstitutionRead, rbac.PlatformTenantsRW)
		id.InstitutionID = schoolA
		id.PlatformAdmin = true

		for _, needle := range []string{
			indexSecretMarker,     // the sealed bytes themselves
			"crm.example.test",    // crm_api_credentials.base_url
			"api.zoom.test",       // virtual_meeting_platform_providers.base_url
			"acct-index",          // ... .account_ref
			"portal.example.test", // child_info_portal_connectors.endpoint_url
			"idxuser",             // ... .username
			"mail.school-a.test",  // the school's own SMTP host
			"office@",             // ... and its From address
		} {
			assertBodyExcludes(t, s, id, needle)
		}
	})
}

// --- helpers -----------------------------------------------------------------

// indexSecretMarker is planted in every seeded credential below. If it ever
// appears in a response body, something is returning a stored secret.
const indexSecretMarker = "NEVER-IN-A-RESPONSE-BODY"

func getIndex(t *testing.T, s *Server, id *httpx.Identity) indexResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/integrations/index", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(), id))
	w := httptest.NewRecorder()
	s.listIntegrationsIndex(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("index returned %d: %s", w.Code, w.Body.String())
	}
	var out indexResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (body %s)", err, w.Body.String())
	}
	return out
}

func assertBodyExcludes(t *testing.T, s *Server, id *httpx.Identity, needle string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/integrations/index", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(), id))
	w := httptest.NewRecorder()
	s.listIntegrationsIndex(w, req)
	if strings.Contains(w.Body.String(), needle) {
		t.Errorf("response body contains %q, which it must never carry", needle)
	}
}

func seedIndexSchool(t *testing.T, db *database.DB, name string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	inst := uuid.New()
	suffix := inst.String()[:8]
	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO institutions (id, name, short_name, slug, timezone, status)
			VALUES ($1, $2, 'IDX', $3, 'Asia/Kolkata', 'active')`,
			inst, name, "idx-"+suffix)
		return err
	})
	if err != nil {
		t.Fatalf("seed school: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, inst)
			return err
		})
	})
	return inst
}

func seedTallyCompany(t *testing.T, db *database.DB, inst uuid.UUID, company string) {
	t.Helper()
	ctx := context.Background()
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO tally_connector_settings (institution_id, company_name, delivery, is_enabled)
			VALUES ($1, $2, 'file', true)`, inst, company)
		return err
	})
	if err != nil {
		t.Fatalf("seed tally: %v", err)
	}
}

func seedSMTP(t *testing.T, db *database.DB, inst uuid.UUID, host string) {
	t.Helper()
	ctx := context.Background()
	cfg := `{"host":"` + host + `","port":587,"from_address":"office@` + host + `"}`
	err := db.InTenant(ctx, database.Scope{InstitutionID: inst}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO integrations (institution_id, provider, kind, config, enabled, credentials)
			VALUES ($1, 'email', 'messaging', $2::jsonb, true, $3::bytea)`,
			inst, cfg, []byte(indexSecretMarker))
		return err
	})
	if err != nil {
		t.Fatalf("seed smtp: %v", err)
	}
}

// seedPlatformConnectors fills all three vendor tables. The point is that this
// state exists and is still invisible below the line.
func seedPlatformConnectors(t *testing.T, db *database.DB) {
	t.Helper()
	ctx := context.Background()
	crm := uuid.New()
	meet := uuid.New()
	child := uuid.New()

	err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm_api_credentials (id, provider, base_url, credentials, notes)
			VALUES ($1, 'meritto', 'https://crm.example.test', $2::bytea, 'index test')`,
			crm, []byte(indexSecretMarker)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO virtual_meeting_platform_providers
			    (id, provider, display_name, account_ref, auth_style, base_url,
			     credentials, is_enabled)
			VALUES ($1, 'zoom', 'Index Test Zoom', 'acct-index', 'oauth_s2s',
			        'https://api.zoom.test', $2::bytea, true)`,
			meet, []byte(indexSecretMarker)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO child_info_portal_connectors
			    (id, state_code, name, provider, endpoint_url, username,
			     credentials, is_enabled)
			VALUES ($1, 'IDX', 'Index Test Portal', 'api',
			        'https://portal.example.test', 'idxuser', $2::bytea, true)`,
			child, []byte(indexSecretMarker))
		return err
	})
	if err != nil {
		t.Fatalf("seed platform connectors: %v", err)
	}
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			c := context.Background()
			_, _ = tx.Exec(c, `DELETE FROM crm_api_credentials WHERE id = $1`, crm)
			_, _ = tx.Exec(c, `DELETE FROM virtual_meeting_platform_providers WHERE id = $1`, meet)
			_, _ = tx.Exec(c, `DELETE FROM child_info_portal_connectors WHERE id = $1`, child)
			return nil
		})
	})
}
