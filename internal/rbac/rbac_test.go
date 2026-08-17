package rbac

import "testing"

// Every key a role grants must exist in All, or the seeder writes a
// role_permissions row whose permission_key has no matching permission -- and
// the foreign key rejects the whole seed at deploy time.
func TestSystemRolesOnlyGrantKnownPermissions(t *testing.T) {
	known := make(map[string]bool, len(All))
	for _, p := range All {
		known[p.Key] = true
	}
	for _, role := range SystemRoles {
		for _, key := range role.Permissions {
			if !known[key] {
				t.Errorf("role %q grants unknown permission %q", role.Key, key)
			}
		}
	}
}

func TestPermissionKeysAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range All {
		if seen[p.Key] {
			t.Errorf("duplicate permission key %q", p.Key)
		}
		seen[p.Key] = true
	}
}

func TestRoleKeysAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range SystemRoles {
		if seen[r.Key] {
			t.Errorf("duplicate role key %q", r.Key)
		}
		seen[r.Key] = true
	}
}

// institution_admin is the tenant's superuser but must not be able to manage
// other tenants -- that is what the platform.* keys are for.
func TestInstitutionAdminHasNoPlatformPermissions(t *testing.T) {
	for _, r := range SystemRoles {
		if r.Key != "institution_admin" {
			continue
		}
		for _, key := range r.Permissions {
			if key == PlatformTenantsRW || key == PlatformPlansRW {
				t.Errorf("institution_admin must not hold %q", key)
			}
		}
		if len(r.Permissions) != len(All)-2 {
			t.Errorf("institution_admin should hold every non-platform key: got %d, want %d",
				len(r.Permissions), len(All)-2)
		}
		return
	}
	t.Fatal("institution_admin role not found")
}

// Self-service keys are what the student and parent portals run on; without
// them those roles can sign in and see nothing.
func TestPortalRolesHaveSelfService(t *testing.T) {
	for _, key := range []string{"student", "parent"} {
		for _, r := range SystemRoles {
			if r.Key != key {
				continue
			}
			var hasProfile bool
			for _, p := range r.Permissions {
				if p == SelfProfileRead {
					hasProfile = true
				}
			}
			if !hasProfile {
				t.Errorf("role %q is missing %q", key, SelfProfileRead)
			}
		}
	}
}
