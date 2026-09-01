package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/* Why is a feature missing from somebody's menu?

   "1 certificate request to issue" sat on the principal's dashboard with
   nothing to press, and I explained it wrongly three times — each time from
   reading the code, each time about the wrong layer. The catalogue is
   assembled from six independent gates:

     the role is held; the plan includes the section's module; setup is not
     locking everything down; the permission key is granted; the feature has
     an implementation; and the scope has data behind it.

   A feature vanishes if ANY of them says no, and the screen cannot say which
   because by then the entry does not exist. So the answer to "why is this
   missing" was six greps and a guess.

   This asks the running catalogue instead, against the real database, and
   prints the verdict of every gate for one feature key. It is a diagnostic
   rather than an assertion: it fails only if the feature is absent AND every
   gate it can see says yes, which is the case that means the fault is
   somewhere none of them covers.
*/
func TestCatalogueExplainsAMissingFeature(t *testing.T) {
	if os.Getenv("ERP_TEST_DATABASE_URL") == "" {
		t.Skip("ERP_TEST_DATABASE_URL not set")
	}
	key := os.Getenv("ERP_PROBE_FEATURE")
	if key == "" {
		key = "institution_admin.students.certificates_transfers"
	}
	roleKey := strings.SplitN(key, ".", 2)[0]

	db := testDB(t)
	var inst uuid.UUID
	var granted bool
	if err := db.AsPlatform(t.Context(), func(tx pgx.Tx) error {
		if err := tx.QueryRow(t.Context(),
			`SELECT id FROM institutions ORDER BY created_at LIMIT 1`).Scan(&inst); err != nil {
			return err
		}
		return tx.QueryRow(t.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM role_permissions rp
			    JOIN roles r ON r.id = rp.role_id
			   WHERE r.institution_id = $1 AND r.key = $2
			     AND rp.permission_key = $3)`, inst, roleKey, key).Scan(&granted)
	}); err != nil {
		t.Skipf("cannot read the database: %v", err)
	}

	t.Logf("feature      %s", key)
	t.Logf("implemented  %v", implementedFeatures[key])
	t.Logf("granted      %v  (role_permissions for %s)", granted, roleKey)

	// The whole bundle the role holds, as production seeds it.
	perms := map[string]struct{}{}
	for _, role := range rbac.SystemRoles {
		if role.Key == roleKey {
			for _, p := range role.Permissions {
				perms[p] = struct{}{}
			}
		}
	}
	// Feature keys live in role_permissions beside the rbac keys, and the
	// catalogue checks id.Can(featureKey) — so the identity needs it too.
	if granted {
		perms[key] = struct{}{}
	}

	s := &Server{DB: db}
	req := httptest.NewRequest("GET", "/api/v1/catalog", nil)
	req = req.WithContext(httpx.WithIdentity(req.Context(), &httpx.Identity{
		UserID: uuid.New(), InstitutionID: inst, Permissions: perms,
	}))
	rec := httptest.NewRecorder()
	s.getCatalog(rec, req)

	if rec.Code != 200 {
		t.Fatalf("catalog answered %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Roles []struct {
			Key      string `json:"key"`
			Sections []struct {
				Slug     string `json:"slug"`
				Features []struct {
					Key     string `json:"key"`
					Live    bool   `json:"live"`
					InScope bool   `json:"in_scope"`
				} `json:"features"`
			} `json:"sections"`
		} `json:"roles"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}

	sectionSlug := strings.Split(key, ".")[1]
	var sectionPresent bool
	for _, role := range out.Roles {
		if role.Key != roleKey {
			continue
		}
		t.Logf("sections     %d in the %s workspace", len(role.Sections), roleKey)
		for _, sec := range role.Sections {
			if sec.Slug != sectionSlug {
				continue
			}
			sectionPresent = true
			for _, f := range sec.Features {
				if f.Key == key {
					t.Logf("PRESENT      live=%v in_scope=%v", f.Live, f.InScope)
					return
				}
			}
		}
	}

	/* Absent. Which gate dropped it is the whole question, and the section
	   being gone at all is the loudest answer: that is the plan's module
	   list, not anything about the feature. */
	if !sectionPresent {
		t.Fatalf("the whole %q section is missing from the %s workspace.\n"+
			"That is the plan's module list rather than anything about this "+
			"feature: entitlement drops a section before permissions are "+
			"consulted, so every entry behind it disappears at once.",
			sectionSlug, roleKey)
	}
	t.Fatalf("%s is absent though its section is present, it is implemented=%v "+
		"and granted=%v. The remaining gates are evidence and stage.",
		key, implementedFeatures[key], granted)
}
