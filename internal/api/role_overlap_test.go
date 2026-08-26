package api

import (
	"fmt"
	"sort"
	"testing"

	"github.com/school-erp/erp/internal/catalog"
)

/*
No two grantable roles may be the same workspace twice.

	The rule was written from two pairs somebody noticed. This computes it from
	the catalogue instead, so a role that grows into duplicating another is
	caught the day it grows rather than the day a school complains that one
	person has the front desk listed twice.

	Measured against the SMALLER role, which is the question a person actually
	has: "does this second role show me anything the first one did not". A
	receptionist whose five entries are all inside admissions adds nothing,
	however large admissions is.

	Personal entries are excluded outright rather than tolerated: My pay and
	my leave are held by the employee, not by the role, and two roles sharing
	them share nothing about the job. Of what remains, the threshold is half —
	pairs like hod+institution_admin, at 31%, are a vice-principal who genuinely
	does two jobs. Above it the second role is a copy.
*/
const overlapCeiling = 50

// grantableRoles are the workspaces a school hands out from the roles screen.
// Portal roles come from a record link and platform roles are the vendor's.
func grantableRoles() map[string]map[[2]string]bool {
	skip := map[string]bool{
		"student": true, "parent": true, "super_admin": true, "seller_admin": true,
	}
	out := map[string]map[[2]string]bool{}
	for _, role := range catalog.Roles {
		if skip[role.Key] {
			continue
		}
		set := map[[2]string]bool{}
		for _, sec := range role.Sections {
			/* What somebody holds as a person, not as a role.

			   My pay, my leave, my profile: every role carries these because
			   every role is held by an employee, and two roles sharing them
			   share nothing about the job. Left in, they were harmless while
			   the smallest role had a dozen entries — and the moment the front
			   desk collapsed to one screen plus My pay, that one shared entry
			   was half the role and four honest pairs failed. */
			if sec.Slug == "my_profile" {
				continue
			}
			for _, f := range sec.Features {
				/* The staff address book, for the same reason.

				   Every employee can write to every other employee; it is one
				   screen and one capability, held as a colleague rather than
				   as a receptionist or a head of department. Two roles both
				   carrying it are not the same job, and counting it says they
				   are. Only this one feature, not the whole communication
				   section — circulars and grievances are genuinely a
				   principal's work and not a teacher's. */
				if f.Slug == "messages" {
					continue
				}
				set[[2]string{sec.Slug, f.Slug}] = true
			}
		}
		if len(set) > 0 {
			out[role.Key] = set
		}
	}
	return out
}

func TestNoTwoGrantableRolesAreTheSameWorkspace(t *testing.T) {
	roles := grantableRoles()

	banned := map[[2]string]bool{}
	for _, p := range overlappingRoles {
		banned[p] = true
		banned[[2]string{p[1], p[0]}] = true
	}

	keys := make([]string, 0, len(roles))
	for k := range roles {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for i, a := range keys {
		for _, b := range keys[i+1:] {
			shared := 0
			for f := range roles[a] {
				if roles[b][f] {
					shared++
				}
			}
			smaller := len(roles[a])
			if len(roles[b]) < smaller {
				smaller = len(roles[b])
			}
			pct := 100 * shared / smaller
			if pct < overlapCeiling {
				continue
			}
			if banned[[2]string{a, b}] {
				continue // already refused, which is the point
			}
			t.Errorf(
				"%s and %s share %d of the smaller role's %d entries (%d%%) and can still be "+
					"granted together — one of them is the other listed twice. Add the pair to "+
					"overlappingRoles with a remedy, or move the shared entries out of one of them.",
				a, b, shared, smaller, pct)
		}
	}
}

// Every banned pair must say what to do instead. A refusal that only says no
// leaves somebody to guess, and the guess is to grant it from another screen.
func TestEveryOverlapHasARemedy(t *testing.T) {
	for _, p := range overlappingRoles {
		remedy, ok := overlapRemedy[p]
		if !ok || len(remedy) < 40 {
			t.Errorf("%v is refused with no remedy — say where the person gets the "+
				"capability instead", p)
		}
	}
}

// The pairs named must be real roles, or the rule silently protects nothing.
func TestOverlappingRolesExist(t *testing.T) {
	roles := grantableRoles()
	for _, p := range overlappingRoles {
		for _, k := range p {
			if _, ok := roles[k]; !ok {
				t.Errorf("overlappingRoles names %q, which is not a grantable workspace", k)
			}
		}
	}
}

// A readable picture of where every pair actually stands, printed on failure
// of the above so the number is in the same output as the complaint.
func TestOverlapReport(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("run with -v for the overlap table")
	}
	roles := grantableRoles()
	keys := make([]string, 0, len(roles))
	for k := range roles {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	type row struct {
		pct  int
		line string
	}
	var rows []row
	for i, a := range keys {
		for _, b := range keys[i+1:] {
			shared := 0
			for f := range roles[a] {
				if roles[b][f] {
					shared++
				}
			}
			if shared == 0 {
				continue
			}
			smaller := len(roles[a])
			if len(roles[b]) < smaller {
				smaller = len(roles[b])
			}
			pct := 100 * shared / smaller
			rows = append(rows, row{pct, fmt.Sprintf("%3d%%  %s + %s (%d of %d)", pct, a, b, shared, smaller)})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].pct > rows[j].pct })
	for _, r := range rows {
		t.Log(r.line)
	}
}
