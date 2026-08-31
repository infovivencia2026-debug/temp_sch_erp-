package api

import (
	"testing"

	"github.com/school-erp/erp/internal/rbac"
)

/*
The desk that collects the money must not be the desk that sets it.

	Enrolling a child needs students.write, which the admissions office holds.
	Deciding what their family pays needs fees.write, which it does not — and
	the enrol handler accepted a concession in rupees from whoever called it,
	which made the admissions desk a way around the discount book's two-person
	control. An officer could have waived four thousand off a friend's admission
	with nobody's approval and nothing to review, or collected the full fee
	against a reduced invoice and kept the difference.

	The handler now refuses a concession from anybody without fees.write. That
	guard is only worth anything while the two rights stay in different hands,
	so this asserts the separation itself: the day somebody adds fees.write to
	admissions "so they can take the money at the counter", this fails and says
	what it costs.
*/
func TestTheDeskThatEnrolsCannotSetThePrice(t *testing.T) {
	desks := map[string]bool{"admissions": true, "front_office": true}

	for _, role := range rbac.SystemRoles {
		if !desks[role.Key] {
			continue
		}
		var enrols, prices bool
		for _, p := range role.Permissions {
			switch p {
			case rbac.StudentsWrite:
				enrols = true
			case rbac.FeesWrite:
				prices = true
			}
		}
		if enrols && prices {
			t.Errorf("%s can both enrol a child and set what they pay. "+
				"Segregation of duties is the only thing standing between an "+
				"admissions officer and an unapproved discount, and the "+
				"concession guard on the enrol route relies on it.", role.Key)
		}
	}
}

/*
Platform roles are the vendor's, and a school must not be able to grant one.

	seller_admin operates the business: every school on the installation, their
	plans, their prices, the power to suspend one. It sat in the role dropdown of
	a school's add-staff form, and the API behind it would have granted it.
	super_admin beside it was withheld in all three places — the list, the grant
	and the appointment — and seller_admin in none.
*/
func TestPlatformRolesAreWithheldFromSchools(t *testing.T) {
	for _, key := range []string{"super_admin", "seller_admin"} {
		if !platformOnlyRoles[key] {
			t.Errorf("%s is not on platformOnlyRoles, so a school's HR can appoint "+
				"somebody to it", key)
		}
	}
	// The slice the queries filter on must agree with the map, or the list and
	// the grant enforce different rules.
	got := map[string]bool{}
	for _, k := range platformOnlyKeys() {
		got[k] = true
	}
	for k := range platformOnlyRoles {
		if !got[k] {
			t.Errorf("%s is withheld on grant but still offered by the list", k)
		}
	}
}
