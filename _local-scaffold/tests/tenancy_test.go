package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/database"
)

func jsonUnmarshal(data []byte, into any) error { return json.Unmarshal(data, into) }

// TestRowLevelSecurityFailsClosed is the test that justifies the whole RLS
// design. The application role, with no organisation bound, must see nothing —
// so a query that forgets its tenant filter returns an empty result rather than
// another school's records.
func TestRowLevelSecurityFailsClosed(t *testing.T) {
	ctx := context.Background()

	// No tenant bound: InTx deliberately does not set app.organization_id.
	count, err := database.InTx(ctx, h.db, func(tx database.Tx) (int, error) {
		var n int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM schools`).Scan(&n)
		return n, err
	})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if count != 0 {
		t.Errorf("with no organisation bound the app role saw %d schools, want 0 — "+
			"row-level security is not applying, check that the app connects as a "+
			"non-owner role and that FORCE ROW LEVEL SECURITY is set", count)
	}
}

// TestCrossTenantReadReturnsNothing binds a different organisation and confirms
// the seeded data becomes invisible. This is the check that would catch a
// policy accidentally written as USING (true).
func TestCrossTenantReadReturnsNothing(t *testing.T) {
	ctx := context.Background()
	otherOrg := uuid.MustParse("00000000-0000-0000-0000-0000000000ff")

	for _, table := range []string{"schools", "users", "campuses", "academic_years", "audit_logs"} {
		t.Run(table, func(t *testing.T) {
			count, err := database.InTenantTx(ctx, h.db, otherOrg, func(tx database.Tx) (int, error) {
				var n int
				err := tx.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n)
				return n, err
			})
			if err != nil {
				t.Fatalf("query %s: %v", table, err)
			}
			if count != 0 {
				t.Errorf("a foreign tenant saw %d rows in %s, want 0", count, table)
			}
		})
	}
}

// TestCannotWriteIntoAnotherTenant exercises the WITH CHECK half of the policy.
// Reading is not the only way to cross a tenant boundary: planting a row in
// someone else's organisation would be worse.
func TestCannotWriteIntoAnotherTenant(t *testing.T) {
	ctx := context.Background()

	ourOrg, err := database.InTx(ctx, h.db, func(tx database.Tx) (uuid.UUID, error) {
		// Read as the owner would not work here (we are the app role), so take
		// the organisation from a session instead.
		var id uuid.UUID
		err := tx.QueryRow(ctx, `SELECT organization_id FROM auth_lookup_login($1)`, orgAdmin).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("resolve organisation: %v", err)
	}

	_, err = database.InTenantTx(ctx, h.db, ourOrg, func(tx database.Tx) (struct{}, error) {
		_, err := tx.Exec(ctx, `
			INSERT INTO schools (organization_id, name, code)
			VALUES ('00000000-0000-0000-0000-0000000000ff', 'Injected', 'INJ')`)
		return struct{}{}, err
	})
	if err == nil {
		t.Fatal("inserted a school into another organisation — the WITH CHECK clause is missing")
	}
}

// TestAuditLogIsAppendOnly. The application role holds INSERT and SELECT on
// audit_logs and nothing else: an audit trail the application can rewrite is
// not an audit trail. This is enforced by revoked privileges, so it holds even
// if application code is compromised.
func TestAuditLogIsAppendOnly(t *testing.T) {
	ctx := context.Background()

	org, err := database.InTx(ctx, h.db, func(tx database.Tx) (uuid.UUID, error) {
		var id uuid.UUID
		err := tx.QueryRow(ctx, `SELECT organization_id FROM auth_lookup_login($1)`, orgAdmin).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatalf("resolve organisation: %v", err)
	}

	t.Run("update is denied", func(t *testing.T) {
		_, err := database.InTenantTx(ctx, h.db, org, func(tx database.Tx) (struct{}, error) {
			_, err := tx.Exec(ctx, `UPDATE audit_logs SET action = 'nothing_happened'`)
			return struct{}{}, err
		})
		if err == nil {
			t.Fatal("the application role was able to rewrite the audit log")
		}
		if !database.IsInsufficientPrivilege(err) {
			t.Errorf("expected a privilege error, got: %v", err)
		}
	})

	t.Run("delete is denied", func(t *testing.T) {
		_, err := database.InTenantTx(ctx, h.db, org, func(tx database.Tx) (struct{}, error) {
			_, err := tx.Exec(ctx, `DELETE FROM audit_logs`)
			return struct{}{}, err
		})
		if err == nil {
			t.Fatal("the application role was able to delete audit entries")
		}
		if !database.IsInsufficientPrivilege(err) {
			t.Errorf("expected a privilege error, got: %v", err)
		}
	})
}

// TestWritesAreAudited: every mutation through the API leaves a record naming
// the actor, and an update captures both the before and the after state.
func TestWritesAreAudited(t *testing.T) {
	admin := signIn(t, orgAdmin)

	created := admin.do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"Audit Trail School","code":"AUD-TRL"}`)
	if created.status != http.StatusCreated {
		t.Fatalf("create: %d %s", created.status, created.body)
	}
	var school schoolPayload
	created.decodeData(t, &school)

	updated := admin.do(t, http.MethodPatch, "/api/v1/schools/"+school.ID,
		`{"name":"Audit Trail School (Renamed)"}`)
	if updated.status != http.StatusOK {
		t.Fatalf("update: %d %s", updated.status, updated.body)
	}

	resp := signIn(t, auditor).get(t, "/api/v1/audit-logs?entity_kind=school&entity_id="+school.ID)
	if resp.status != http.StatusOK {
		t.Fatalf("read audit log: %d %s", resp.status, resp.body)
	}

	var entries []struct {
		Action    string          `json:"action"`
		ActorName string          `json:"actor_name"`
		Before    json.RawMessage `json:"before"`
		After     json.RawMessage `json:"after"`
		RequestID string          `json:"request_id"`
	}
	resp.decodeData(t, &entries)

	seen := map[string]bool{}
	for _, e := range entries {
		seen[e.Action] = true

		if e.ActorName != "Priya Nair" {
			t.Errorf("%s: actor = %q, want the user who made the change", e.Action, e.ActorName)
		}
		if e.RequestID == "" {
			t.Errorf("%s: no request id recorded", e.Action)
		}
		if e.Action == "school.update" {
			var before, after schoolPayload
			if err := json.Unmarshal(e.Before, &before); err != nil {
				t.Fatalf("decode before: %v", err)
			}
			if err := json.Unmarshal(e.After, &after); err != nil {
				t.Fatalf("decode after: %v", err)
			}
			if before.Name != "Audit Trail School" {
				t.Errorf("before state = %q, want the original name", before.Name)
			}
			if after.Name != "Audit Trail School (Renamed)" {
				t.Errorf("after state = %q, want the new name", after.Name)
			}
		}
	}

	for _, action := range []string{"school.create", "school.update"} {
		if !seen[action] {
			t.Errorf("no audit entry for %s", action)
		}
	}
}

// TestAuditIsRolledBackWithItsTransaction: the audit row and the business change
// commit together or not at all. Here the change fails on a unique constraint,
// so no orphan audit entry may survive.
func TestAuditIsRolledBackWithItsTransaction(t *testing.T) {
	admin := signIn(t, orgAdmin)

	if resp := admin.do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"Rollback Original","code":"ROLLBK"}`); resp.status != http.StatusCreated {
		t.Fatalf("seed the conflict: %d %s", resp.status, resp.body)
	}

	before := auditCount(t, "school.create")

	if resp := admin.do(t, http.MethodPost, "/api/v1/schools",
		`{"name":"Rollback Duplicate","code":"ROLLBK"}`); resp.status != http.StatusConflict {
		t.Fatalf("expected a conflict, got %d %s", resp.status, resp.body)
	}

	if after := auditCount(t, "school.create"); after != before {
		t.Errorf("a failed create left %d audit entries behind (before %d, after %d)",
			after-before, before, after)
	}
}

func auditCount(t *testing.T, action string) int {
	t.Helper()
	resp := signIn(t, auditor).get(t, "/api/v1/audit-logs?action="+action+"&limit=200")
	if resp.status != http.StatusOK {
		t.Fatalf("read audit log: %d %s", resp.status, resp.body)
	}
	var entries []json.RawMessage
	resp.decodeData(t, &entries)
	return len(entries)
}
