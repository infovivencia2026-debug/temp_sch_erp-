package rbac

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// A key that belongs to no group is invisible on the configuration screen and
// cannot be granted without a shell. A key in two groups is worse: saving one
// group silently rewrites the other.
func TestGroupsCoverEveryPermissionExactlyOnce(t *testing.T) {
	owner := map[string]string{}
	for _, g := range Groups {
		for _, list := range [][]string{g.View, g.Manage, g.Approve, g.Export} {
			for _, k := range list {
				if prev, dup := owner[k]; dup {
					t.Errorf("permission %q is in both %q and %q", k, prev, g.Key)
				}
				owner[k] = g.Key
			}
		}
		for _, s := range g.Scopes {
			for _, list := range [][]string{s.Keys, s.WriteKeys} {
				for _, k := range list {
					if prev, dup := owner[k]; dup {
						t.Errorf("permission %q is in both %q and %q", k, prev, g.Key)
					}
					owner[k] = g.Key
				}
			}
		}
	}
	for _, p := range All {
		if _, ok := owner[p.Key]; !ok {
			t.Errorf("permission %q belongs to no feature group", p.Key)
		}
	}
	known := map[string]bool{}
	for _, p := range All {
		known[p.Key] = true
	}
	for k, g := range owner {
		if !known[k] {
			t.Errorf("group %q names %q, which is not a real permission", g, k)
		}
	}
}

func TestGroupKeysAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, g := range Groups {
		if seen[g.Key] {
			t.Errorf("duplicate group key %q", g.Key)
		}
		seen[g.Key] = true
		if len(g.View) == 0 && len(g.Manage) == 0 {
			t.Errorf("group %q offers no level at all", g.Key)
		}
		if len(g.Scopes) == 0 {
			t.Errorf("group %q declares no scope", g.Key)
		}
	}
}

/*
The round trip is the whole contract.

	Whatever the grid shows for a role, saving it unchanged must produce the
	permission set it started from. If it does not, opening the screen and
	pressing Save silently changes what somebody can do — the single worst
	failure this feature could have, and one no reviewer would spot by reading
	a role definition.
*/
func TestGridRoundTripsEverySystemRole(t *testing.T) {
	for _, role := range SystemRoles {
		want := append([]string(nil), role.Permissions...)
		sort.Strings(want)

		got := Apply(Read(role.Permissions))

		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Errorf("role %q does not survive a round trip\n lost: %v\nadded: %v",
				role.Key, diff(want, got), diff(got, want))
		}
	}
}

/*
No seeded role should need an extra key.

	Extras are legal and preserved, because a school that hand-tunes a custom
	role must not lose that grant on the next save. But a *built-in* role that
	needs one is telling us the group boundaries are drawn in the wrong place:
	whoever opens the screen sees "View, plus 1 other permission" and has no
	way to reason about it.

	Every one of the twenty-four currently lands on a clean level. If a new
	role or a regrouping breaks that, the honest fix is usually to split the
	group — Users & roles was split from Audit trail & jobs for exactly this
	reason — not to widen the role.
*/
func TestNoSystemRoleNeedsExtraKeys(t *testing.T) {
	for _, role := range SystemRoles {
		for _, st := range Read(role.Permissions) {
			if len(st.Extra) > 0 {
				t.Errorf("role %q carries %v in group %q, which its %s level does not imply",
					role.Key, st.Extra, st.Group, st.Level)
			}
		}
	}
}

// A widener with nothing under it is a grant that reads as access and delivers
// none: attendance.read.all does not open a single endpoint, because they all
// gate on attendance.read. Read must surface it rather than absorb it.
func TestOrphanedScopeKeySurfacesAsExtra(t *testing.T) {
	states := Read([]string{AttendanceReadAll})
	for _, st := range states {
		if st.Group != "attendance" {
			continue
		}
		if st.Level != "none" {
			t.Errorf("attendance level is %q with no read key", st.Level)
		}
		if len(st.Extra) != 1 || st.Extra[0] != AttendanceReadAll {
			t.Errorf("expected %q to surface as an extra, got %v", AttendanceReadAll, st.Extra)
		}
		return
	}
	t.Fatal("attendance group not found")
}

// Approve and Export must not survive a drop to No Access: a refund right on a
// ledger the person cannot open is a grant nobody can see and nobody revokes.
func TestTogglesAreIgnoredWithoutAccess(t *testing.T) {
	keys := Apply([]GroupState{
		{Group: "fees", Level: "none", Approve: true, Export: true},
		{Group: "students", Level: "none", Approve: true, Export: true},
	})
	if len(keys) != 0 {
		t.Errorf("toggles granted %v at the none level", keys)
	}
}

// Widening attendance to the whole school must not hand out the right to mark
// a register unless the role can mark at all.
func TestScopeWriteKeysFollowTheLevel(t *testing.T) {
	view := Apply([]GroupState{{Group: "attendance", Level: "view", Scope: "institution"}})
	if contains(view, AttendanceWriteAny) {
		t.Error("view-level attendance granted the right to mark any section")
	}
	if !contains(view, AttendanceReadAll) {
		t.Error("institution scope did not grant institution-wide attendance reading")
	}
	manage := Apply([]GroupState{{Group: "attendance", Level: "manage", Scope: "institution"}})
	if !contains(manage, AttendanceWriteAny) {
		t.Error("manage-level attendance at institution scope cannot mark any section")
	}
}

// The migration labels roles by hand because SQL cannot import Go. This is the
// check that keeps the two lists honest.
func TestOptionalRolesMatchMigration(t *testing.T) {
	sql, err := os.ReadFile("../../migrations/00016_role_defaults.sql")
	if err != nil {
		t.Skipf("migration not readable: %v", err)
	}
	// A later migration may promote a role out of the optional set. Reading
	// only 00016 would then fail forever on a list the database no longer
	// agrees with, which teaches people to edit an applied migration.
	promoted := map[string]bool{}
	if later, err := os.ReadFile("../../migrations/00132_hod_is_default.sql"); err == nil {
		for _, m := range regexp.MustCompile(`key = '([a-z_]+)'`).FindAllStringSubmatch(string(later), -1) {
			promoted[m[1]] = true
		}
	}
	quoted := regexp.MustCompile(`'([a-z_]+)'`)
	block := string(sql)
	start := strings.Index(block, "WHERE is_system")
	end := strings.Index(block, "-- A custom role")
	if start < 0 || end < 0 {
		t.Fatal("could not find the labelling statement in the migration")
	}
	inSQL := map[string]bool{}
	for _, m := range quoted.FindAllStringSubmatch(block[start:end], -1) {
		if promoted[m[1]] {
			continue
		}
		inSQL[m[1]] = true
	}
	// Roles that became optional after 00016 are labelled in their own
	// migration, in the same shape; each of those files is read too.
	for _, later := range []string{"../../migrations/00231_board_member_optional.sql"} {
		if b, err := os.ReadFile(later); err == nil {
			for _, m := range quoted.FindAllStringSubmatch(string(b), -1) {
				inSQL[m[1]] = true
			}
		}
	}
	for key := range optionalRoles {
		if !inSQL[key] {
			t.Errorf("role %q is optional in Go but not labelled in the migration", key)
		}
	}
	for key := range inSQL {
		if !optionalRoles[key] {
			t.Errorf("role %q is labelled optional in the migration but not in Go", key)
		}
	}
}

// Every optional role must still be a real role, or installing it 404s.
func TestOptionalRolesExist(t *testing.T) {
	known := map[string]bool{}
	for _, r := range SystemRoles {
		known[r.Key] = true
	}
	for key := range optionalRoles {
		if !known[key] {
			t.Errorf("optional role %q is not in SystemRoles", key)
		}
	}
}

// support_admin is a platform role, and a platform role that can read a school
// is one that reads every school at once.
func TestSupportAdminHoldsNoSchoolData(t *testing.T) {
	forbidden := map[string]bool{
		StudentsRead: true, StudentsReadAll: true, AttendanceRead: true,
		FeesRead: true, InvoicesRead: true, PaymentsRead: true,
		HealthRead: true, CounselingRead: true, EmployeesRead: true,
		PayrollRead: true, AdmissionsRead: true,
	}
	for _, k := range SupportAdminPermissions {
		if forbidden[k] {
			t.Errorf("support_admin must not hold %q", k)
		}
	}
	if !PlatformRoles["support_admin"] {
		t.Error("support_admin must be a platform role, or it is seeded per tenant")
	}
}

// vice_principal exists so a school stops handing out institution_admin for
// academic supervision. If it can reach money or salaries, it has not.
func TestVicePrincipalHoldsNoFinanceOrPayroll(t *testing.T) {
	for _, r := range SystemRoles {
		if r.Key != "vice_principal" {
			continue
		}
		for _, k := range r.Permissions {
			if strings.HasPrefix(k, "finance.") || strings.HasPrefix(k, "hr.payroll") ||
				strings.HasPrefix(k, "access.") || strings.HasPrefix(k, "platform.") {
				t.Errorf("vice_principal must not hold %q", k)
			}
		}
		return
	}
	t.Fatal("vice_principal role not found")
}

func contains(list []string, key string) bool {
	for _, k := range list {
		if k == key {
			return true
		}
	}
	return false
}

// diff returns the members of a that are missing from b.
func diff(a, b []string) []string {
	in := make(map[string]bool, len(b))
	for _, k := range b {
		in[k] = true
	}
	var out []string
	for _, k := range a {
		if !in[k] {
			out = append(out, k)
		}
	}
	return out
}
