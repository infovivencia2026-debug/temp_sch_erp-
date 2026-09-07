package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/auth"
	"github.com/school-erp/erp/internal/catalog"
	"github.com/school-erp/erp/internal/database"
	"github.com/school-erp/erp/internal/entitlement"
	"github.com/school-erp/erp/internal/httpx"
	"github.com/school-erp/erp/internal/rbac"
)

/*
Why is a feature missing from somebody's menu?

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

	Which school it asks matters, and it used to be whichever institution was
	oldest. On the test database that is a suspended end-to-end leftover with
	no subscription row at all, and a school with no subscription is entitled
	to no module -- so the probe reported the Students section gone "because
	of the plan's module list", about a school that has no plan, and the
	printout had no line that would have said so. The plan and setup gates
	are now printed beside the others, and the school is provisioned here the
	way a sale provisions one, on the plan the seller console defaults to,
	with its setup finished, so the only way for the section to be missing is
	the way that would hide it from a real principal. Set
	ERP_PROBE_INSTITUTION to a school's id to ask about a real one instead.
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
	inst, userID := probeSchool(t, db)

	var granted bool
	var ent entitlement.State
	if err := db.AsPlatform(t.Context(), func(tx pgx.Tx) error {
		var err error
		if ent, err = entitlement.Resolve(t.Context(), tx, inst); err != nil {
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

	sectionSlug := strings.Split(key, ".")[1]
	module, sellable := entitlement.ModuleFor(sectionSlug)
	t.Logf("school       %s", inst)
	t.Logf("plan         %s (%s) active=%v modules=%v", ent.PlanCode, ent.Status,
		ent.Active, ent.Modules())
	t.Logf("entitled     %v  (section %q is module %q, sellable=%v)",
		ent.Allows(sectionSlug), sectionSlug, module, sellable)
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
		UserID: userID, InstitutionID: inst, Permissions: perms,
	}))
	rec := httptest.NewRecorder()
	s.getCatalog(rec, req)

	if rec.Code != 200 {
		t.Fatalf("catalog answered %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		SetupRequired bool `json:"setup_required"`
		Roles         []struct {
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
	t.Logf("setup done   %v", !out.SetupRequired)

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
	   being gone at all is the loudest answer: a section is dropped whole by
	   the plan or by unfinished setup, before any permission is consulted, so
	   every entry behind it disappears at once. Both verdicts are printed
	   above; the sentence below names the one that said no. */
	if !sectionPresent {
		switch {
		case !ent.Allows(sectionSlug):
			t.Fatalf("the whole %q section is missing from the %s workspace.\n"+
				"That is the plan: %q is the %q module and the school's %s plan "+
				"(%s) does not include it. Entitlement drops the section before "+
				"permissions are consulted, so every entry behind it disappears "+
				"at once.", sectionSlug, roleKey, sectionSlug, module, ent.PlanCode,
				ent.Status)
		case out.SetupRequired && !setupSections[sectionSlug]:
			t.Fatalf("the whole %q section is missing from the %s workspace.\n"+
				"That is setup: until the school profile, classes, sections, "+
				"subjects, staff and students exist, only the setup sections "+
				"are shown.", sectionSlug, roleKey)
		}
		t.Fatalf("the whole %q section is missing from the %s workspace, and "+
			"neither the plan nor setup dropped it. The role filter is the "+
			"remaining section-level gate.", sectionSlug, roleKey)
	}
	t.Fatalf("%s is absent though its section is present, it is implemented=%v "+
		"and granted=%v. The remaining gates are evidence and stage.",
		key, implementedFeatures[key], granted)
}

/*
probeSchool is the school the catalogue is asked about.

	A real one when ERP_PROBE_INSTITUTION names it -- that is the diagnostic
	use, pointed at a database where a principal has reported something
	missing. Otherwise one made here, and made the way a sale makes one:
	through provisionSchool, on the plan the seller console defaults to, paid
	so it is active rather than on trial. Provisioning is what seeds the
	roles, their grants and the subscription, and doing it by hand here would
	be a second copy of that to drift from the first.

	The setup lock is then satisfied with the smallest school that counts as
	set up -- one of each thing setupIncomplete counts -- because a school
	still in setup sees only the setup sections, and a probe that stopped
	there would blame the plan for what the lock did.
*/
func probeSchool(t *testing.T, db *database.DB) (inst, admin uuid.UUID) {
	t.Helper()
	ctx := context.Background()

	if v := os.Getenv("ERP_PROBE_INSTITUTION"); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			t.Fatalf("ERP_PROBE_INSTITUTION: %v", err)
		}
		return id, uuid.New()
	}

	suffix := uuid.NewString()[:8]
	var out provisionResult
	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		/* The permission vocabulary first, because role_permissions has a
		   foreign key to it and a freshly migrated database has not been
		   seeded -- that is `migrate seed`, which nobody runs against the
		   test database. Both vocabularies, exactly as seedPermissions in
		   cmd/migrate writes them: the rbac keys handlers gate on and the
		   catalogue keys that drive navigation. Harmless against a seeded
		   database, where every row is already there. */
		for _, perm := range rbac.All {
			if _, err := tx.Exec(ctx, `
				INSERT INTO permissions (key, module, description)
				VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
				perm.Key, perm.Module, perm.Description); err != nil {
				return err
			}
		}
		for _, role := range catalog.Roles {
			for _, sec := range role.Sections {
				for _, f := range sec.Features {
					if _, err := tx.Exec(ctx, `
						INSERT INTO permissions (key, module, description)
						VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
						f.Key, role.Key, f.Name); err != nil {
						return err
					}
				}
			}
		}
		var err error
		out, err = provisionSchool(ctx, tx, auth.NewHasher("test-pepper"), provisionParams{
			SchoolName: "Probe School " + suffix,
			District:   "Hyderabad", State: "Telangana", Board: "CBSE",
			PlanCode:   "starter",
			Paid:       true,
			AdminName:  "Probe Principal",
			AdminEmail: "principal+" + suffix + "@probe.test",
		})
		return err
	}); err != nil {
		t.Fatalf("provision: %v", err)
	}
	inst, admin = out.InstitutionID, out.UserID
	t.Cleanup(func() {
		_ = db.AsPlatform(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`DELETE FROM institutions WHERE id = $1`, inst)
			return err
		})
	})

	if err := db.AsPlatform(ctx, func(tx pgx.Tx) error {
		var campus, year, class, subject, desig uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM campuses WHERE institution_id = $1 ORDER BY created_at LIMIT 1`,
			inst).Scan(&campus); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO academic_years (institution_id, campus_id, name, starts_on, ends_on, is_current)
			VALUES ($1,$2,'2026-27','2026-04-01','2027-03-31',true) RETURNING id`,
			inst, campus).Scan(&year); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO classes (institution_id, campus_id, name, level)
			VALUES ($1,$2,'Grade 6',6) RETURNING id`, inst, campus).Scan(&class); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO sections (institution_id, campus_id, class_id, academic_year_id, name)
			VALUES ($1,$2,$3,$4,'6-A')`, inst, campus, class, year); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO subjects (institution_id, campus_id, name, code)
			VALUES ($1,$2,'Science','SCI') RETURNING id`, inst, campus).Scan(&subject); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO class_subjects (institution_id, class_id, subject_id)
			VALUES ($1,$2,$3)`, inst, class, subject); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO designations (institution_id, name, category)
			VALUES ($1,'TGT Science','teaching') RETURNING id`, inst).Scan(&desig); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO employees (institution_id, campus_id, employee_code, first_name,
			        designation_id, joined_on, status)
			VALUES ($1,$2,$3,'Asha',$4,'2024-06-01','active')`,
			inst, campus, "E-"+suffix, desig); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO students (institution_id, campus_id, admission_no, first_name, status)
			VALUES ($1,$2,$3,'Child','active')`, inst, campus, "A-"+suffix)
		return err
	}); err != nil {
		t.Fatalf("finish setup: %v", err)
	}
	return inst, admin
}
